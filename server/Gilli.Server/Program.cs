using System.Text.Json.Serialization;
using Gilli.Core;
using Gilli.Core.Rooms;
using Gilli.Server;
using Microsoft.AspNetCore.SignalR;

// Content root = the folder the server binary lives in, so wwwroot and appsettings.json are found
// no matter which directory the process is started from (e.g. "dotnet publish/Gilli.Server.dll").
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = args, ContentRootPath = AppContext.BaseDirectory });
builder.WebHost.ConfigureKestrel(k =>
{
    k.AddServerHeader = false;                       // do not advertise the server software
    k.Limits.MaxRequestBodySize = 64 * 1024;         // the game never uploads anything large
    k.Limits.MaxConcurrentConnections = 5000;
    k.Limits.MaxRequestHeadersTotalSize = 16 * 1024;
});
// Hosting platforms (Render, Railway, Heroku-style) tell a container which port to listen on via PORT.
if (Environment.GetEnvironmentVariable("DOTNET_RUNNING_IN_CONTAINER") == "true" && int.TryParse(Environment.GetEnvironmentVariable("PORT"), out var platformPort))
    builder.WebHost.UseUrls($"http://+:{platformPort}");
var security = builder.Configuration.GetSection("Security").Get<SecurityOptions>() ?? new SecurityOptions();

// Allowed browser origins for the SignalR client (the Vite dev server in development).
// Production: set Cors__Origins__0=https://your-site.example (not needed when the server hosts the built client itself).
var origins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? Array.Empty<string>();

builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
{
    if (origins.Length > 0) p.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod().AllowCredentials();
}));
builder.Services.AddSignalR(o =>
{
    o.AddFilter<RateLimitHubFilter>();
    o.MaximumParallelInvocationsPerClient = 1;
    o.EnableDetailedErrors = builder.Environment.IsDevelopment();
    o.MaximumReceiveMessageSize = 16 * 1024;
    o.KeepAliveInterval = TimeSpan.FromSeconds(10);
    o.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
}).AddJsonProtocol(o => o.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
// Behind a TLS-terminating host set ASPNETCORE_FORWARDEDHEADERS_ENABLED=true (the Dockerfile does) so the real
// client IP and https scheme are used. It is off by default: when exposed directly, X-Forwarded-For could be forged.
builder.Services.AddSingleton(security);
builder.Services.AddSingleton<ConnectionLimiter>();
builder.Services.AddSingleton<RateLimitHubFilter>();
builder.Services.AddSingleton(GameConfig.Default);
builder.Services.AddSingleton(FieldLayout.Default);
builder.Services.AddSingleton<RoomManager>();
builder.Services.AddSingleton<Broadcaster>();
builder.Services.AddSingleton<LoopMetrics>();
builder.Services.AddHostedService<GameLoop>();

var app = builder.Build();

// Warm up BEPU (JIT-compiles the simulation code) so the first match does not stall every room's tick.
var warm = System.Diagnostics.Stopwatch.StartNew();
using (var world = new Gilli.Core.Physics.GilliWorld(GameConfig.Default.Physics, FieldLayout.Default))
{
    world.ResetForAttempt(0);
    world.Flick();
    for (int i = 0; i < 34; i++) world.Step();
    world.StartSwing();
    for (int i = 0; i < 240; i++) world.Step();
    world.SetTarget(true);
    world.Throw(new System.Numerics.Vector3(0, 1.5f, -20), MathF.PI, 0.5f, 0.5f);
    for (int i = 0; i < 120; i++) world.Step();
}
app.Logger.LogInformation("Physics warm-up took {Ms} ms", warm.ElapsedMilliseconds);

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler(e => e.Run(ctx => Results.Problem("Unexpected server error").ExecuteAsync(ctx)));
    // HSTS is sent by UseGilliSecurityHeaders (also works behind TLS-terminating proxies such as Render)
}
app.UseGilliSecurityHeaders();
app.UseCors();
app.UseDefaultFiles();
app.UseStaticFiles(); // production: the built website lives in wwwroot

var started = DateTimeOffset.UtcNow;
app.MapGet("/health", (RoomManager rooms) => Results.Ok(new
{
    status = "ok",
    service = "gilli-server",
    rooms = rooms.Count,
    uptimeSeconds = (int)(DateTimeOffset.UtcNow - started).TotalSeconds,
    hub = "/hubs/game",
}));
app.MapGet("/api/layout", (FieldLayout layout) => Results.Ok(new
{
    pit = new { x = 0, z = 0 },
    boundary = new { x = layout.BoundaryCenter.X, z = layout.BoundaryCenter.Y, radius = layout.BoundaryRadius },
    walkRadius = layout.WalkRadius,
    obstacles = layout.Obstacles,
}));
app.MapGet("/api/config", (GameConfig config) => Results.Ok(Room.ClientConfig(config)));
// TEMPORARY diagnostic (to be removed): echoes only the caller's own proxy headers, to configure proxy trust correctly
app.MapGet("/api/proxycheck", (HttpContext ctx) => Results.Ok(new
{
    remoteIp = ctx.Connection.RemoteIpAddress?.ToString(),
    scheme = ctx.Request.Scheme,
    forwardedEnv = Environment.GetEnvironmentVariable("ASPNETCORE_FORWARDEDHEADERS_ENABLED"),
    headers = new[] { "X-Forwarded-For", "X-Forwarded-Proto", "X-Forwarded-Host", "X-Original-For", "X-Original-Proto", "Forwarded", "True-Client-IP", "CF-Connecting-IP", "X-Real-IP", "Rndr-Id" }
        .ToDictionary(h => h, h => ctx.Request.Headers[h].ToString()),
}));
// operational numbers: local callers only unless Security:PublicMetrics is set
app.MapGet("/api/metrics", (HttpContext ctx, RoomManager rooms, LoopMetrics metrics) =>
    security.PublicMetrics || SecurityHeaders.IsLocal(ctx) ? Results.Ok(metrics.Read(rooms.Count)) : Results.NotFound());
app.MapHub<GameHub>("/hubs/game");
if (File.Exists(Path.Combine(app.Environment.WebRootPath ?? "wwwroot", "index.html")))
    app.MapFallbackToFile("index.html");

app.Lifetime.ApplicationStarted.Register(() =>
{
    foreach (var url in app.Urls) app.Logger.LogInformation("Gilli server listening on {Url} (hub {Url}/hubs/game, health {Url}/health)", url, url, url);
});

app.Run();

public partial class Program; // for WebApplicationFactory in tests
