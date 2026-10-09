using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using Gilli.Core.Rooms;
using Microsoft.AspNetCore.SignalR;

namespace Gilli.Server;

/// <summary>Abuse limits. Values can be overridden in configuration under "Security".</summary>
public sealed record SecurityOptions
{
    /// <summary>Most rooms the server will hold at once (each room owns a physics world).</summary>
    public int MaxRooms { get; init; } = 300;
    /// <summary>Concurrent hub connections allowed from one IP address.</summary>
    public int MaxConnectionsPerIp { get; init; } = 12;
    /// <summary>Movement updates per second per connection (the client sends 15).</summary>
    public double MoveRate { get; init; } = 30;
    /// <summary>Game actions (flick, swing, catch, ready, ...) per second per connection.</summary>
    public double ActionRate { get; init; } = 8;
    /// <summary>Create/join/rejoin requests per second per connection (also slows room-code guessing).</summary>
    public double LobbyRate { get; init; } = 0.5;
    /// <summary>Rejected calls in a row after which the connection is dropped.</summary>
    public int AbortAfterRejections { get; init; } = 300;
    /// <summary>Expose /api/metrics to non-local callers.</summary>
    public bool PublicMetrics { get; init; }
}

/// <summary>Token buckets per connection, and connection counts per IP.</summary>
public sealed class ConnectionLimiter(SecurityOptions options)
{
    public enum Kind { Move, Action, Lobby }

    sealed class Bucket(double rate, double capacity)
    {
        readonly double max = capacity;
        double tokens = capacity;
        long last = Stopwatch.GetTimestamp();
        public bool TryTake()
        {
            long now = Stopwatch.GetTimestamp();
            tokens = Math.Min(max, tokens + Stopwatch.GetElapsedTime(last, now).TotalSeconds * rate);
            last = now;
            if (tokens < 1) return false;
            tokens -= 1;
            return true;
        }
    }

    sealed class State(SecurityOptions o)
    {
        public readonly Bucket Move = new(o.MoveRate, o.MoveRate * 1.5);
        public readonly Bucket Action = new(o.ActionRate, o.ActionRate * 2.5);
        public readonly Bucket Lobby = new(o.LobbyRate, Math.Max(5, o.LobbyRate * 2));
        public int Rejections;
        public string? Ip;
    }

    readonly ConcurrentDictionary<string, State> connections = new();
    readonly ConcurrentDictionary<string, int> perIp = new();

    public SecurityOptions Options => options;

    /// <summary>Registers a connection; false when its IP already has too many.</summary>
    public bool Connect(string connectionId, string ip)
    {
        int n = perIp.AddOrUpdate(ip, 1, (_, c) => c + 1);
        connections[connectionId] = new State(options) { Ip = ip };
        return n <= options.MaxConnectionsPerIp;
    }

    public void Disconnect(string connectionId)
    {
        if (connections.TryRemove(connectionId, out var s) && s.Ip is { } ip)
            perIp.AddOrUpdate(ip, 0, (_, c) => Math.Max(0, c - 1));
    }

    /// <returns>allowed, and whether the connection has become abusive and should be dropped.</returns>
    public (bool allowed, bool abusive) TryTake(string connectionId, Kind kind)
    {
        var s = connections.GetOrAdd(connectionId, _ => new State(options));
        bool ok;
        lock (s)
        {
            ok = kind switch { Kind.Move => s.Move.TryTake(), Kind.Lobby => s.Lobby.TryTake(), _ => s.Action.TryTake() };
            s.Rejections = ok ? Math.Max(0, s.Rejections - 1) : s.Rejections + 1;
            return (ok, s.Rejections >= options.AbortAfterRejections);
        }
    }

    public int ConnectionsFrom(string ip) => perIp.TryGetValue(ip, out var n) ? n : 0;
}

/// <summary>
/// Applies the limits to every hub call: flooding a method returns RATE_LIMITED instead of running it,
/// persistent flooding drops the connection, and an IP with too many connections is refused.
/// </summary>
public sealed class RateLimitHubFilter(ConnectionLimiter limiter, ILogger<RateLimitHubFilter> log) : IHubFilter
{
    static string IpOf(HubCallerContext c) => c.GetHttpContext()?.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    public async ValueTask<object?> InvokeMethodAsync(HubInvocationContext ctx, Func<HubInvocationContext, ValueTask<object?>> next)
    {
        var kind = ctx.HubMethodName switch
        {
            nameof(GameHub.Move) or nameof(GameHub.Ping) => ConnectionLimiter.Kind.Move,
            nameof(GameHub.CreateRoom) or nameof(GameHub.CreateVsComputer) or nameof(GameHub.JoinRoom) or nameof(GameHub.Rejoin) => ConnectionLimiter.Kind.Lobby,
            _ => ConnectionLimiter.Kind.Action,
        };
        var (allowed, abusive) = limiter.TryTake(ctx.Context.ConnectionId, kind);
        if (allowed) return await next(ctx);
        if (abusive)
        {
            log.LogWarning("Dropping connection {Connection} from {Ip}: request flood on {Method}", ctx.Context.ConnectionId, IpOf(ctx.Context), ctx.HubMethodName);
            ctx.Context.Abort();
        }
        var returns = ctx.HubMethod.ReturnType;
        if (returns == typeof(void) || returns == typeof(Task)) return null;
        if (returns == typeof(double)) return -1.0;
        return OpResult.Fail(ErrorCodes.RateLimited, "Too many requests: slow down.");
    }

    public async Task OnConnectedAsync(HubLifetimeContext context, Func<HubLifetimeContext, Task> next)
    {
        var ip = IpOf(context.Context);
        if (!limiter.Connect(context.Context.ConnectionId, ip))
        {
            log.LogWarning("Refusing connection from {Ip}: more than {Max} connections", ip, limiter.Options.MaxConnectionsPerIp);
            context.Context.Abort();
            return;
        }
        await next(context);
    }

    public async Task OnDisconnectedAsync(HubLifetimeContext context, Exception? exception, Func<HubLifetimeContext, Exception?, Task> next)
    {
        limiter.Disconnect(context.Context.ConnectionId);
        await next(context, exception);
    }
}

/// <summary>Browser security headers, including a Content-Security-Policy for the game and the classic page.</summary>
public static class SecurityHeaders
{
    public static IApplicationBuilder UseGilliSecurityHeaders(this IApplicationBuilder app) => app.Use(async (ctx, next) =>
    {
        var h = ctx.Response.Headers;
        h["X-Content-Type-Options"] = "nosniff";
        h["Referrer-Policy"] = "no-referrer";
        h["X-Frame-Options"] = "DENY";
        h["Cross-Origin-Opener-Policy"] = "same-origin";
        h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()";
        var host = ctx.Request.Host.Value;
        h["Content-Security-Policy"] = ctx.Request.Path.StartsWithSegments("/classic.html")
            // the unchanged classic game uses an inline script and Three.js r128 from cdnjs
            ? "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
              "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
            : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
              $"img-src 'self' data: blob:; connect-src 'self' ws://{host} wss://{host}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
        // HSTS: tell browsers to use https for a year. Hosts like Render end TLS at their proxy and forward plain
        // http, so the built-in UseHsts() (which needs Request.IsHttps) never fires there; X-Forwarded-Proto tells
        // us the visitor used https. A forged header is harmless: browsers ignore HSTS on plain-http responses.
        bool https = ctx.Request.IsHttps || string.Equals(ctx.Request.Headers["X-Forwarded-Proto"].ToString().Split(',')[0].Trim(), "https", StringComparison.OrdinalIgnoreCase);
        if (https && !IsDevelopment(ctx)) h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
        await next();
    });

    static bool IsDevelopment(HttpContext ctx) => ctx.RequestServices.GetRequiredService<IWebHostEnvironment>().IsDevelopment();

    public static bool IsLocal(HttpContext ctx) => ctx.Connection.RemoteIpAddress is { } ip && IPAddress.IsLoopback(ip);
}
