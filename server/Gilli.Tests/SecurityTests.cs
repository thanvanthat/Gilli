using System.Text.Json.Serialization;
using Gilli.Core;
using Gilli.Core.Rooms;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace Gilli.Tests;

/// <summary>Regression tests for the security review (see SECURITY.md).</summary>
public class SecurityTests
{
    static WebApplicationFactory<Program> Factory(params (string key, string value)[] settings) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b => { foreach (var (k, v) in settings) b.UseSetting(k, v); });

    static async Task<HubConnection> Connect(WebApplicationFactory<Program> f)
    {
        var c = new HubConnectionBuilder()
            .WithUrl(new Uri(f.Server.BaseAddress, "/hubs/game"), o =>
            {
                o.HttpMessageHandlerFactory = _ => f.Server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
            })
            .AddJsonProtocol(o => o.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter()))
            .Build();
        await c.StartAsync();
        return c;
    }

    [Theory]
    [InlineData("/health")]
    [InlineData("/api/layout")]
    public async Task Responses_carry_security_headers_and_hide_the_server_banner(string path)
    {
        using var f = Factory();
        var res = await f.CreateClient().GetAsync(path);
        Assert.Equal("nosniff", res.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("DENY", res.Headers.GetValues("X-Frame-Options").Single());
        Assert.Equal("no-referrer", res.Headers.GetValues("Referrer-Policy").Single());
        var csp = res.Headers.GetValues("Content-Security-Policy").Single();
        Assert.Contains("default-src 'self'", csp);
        Assert.Contains("script-src 'self';", csp);          // no inline or remote scripts for the game
        Assert.Contains("frame-ancestors 'none'", csp);
        Assert.Contains("object-src 'none'", csp);
        Assert.False(res.Headers.Contains("Server"));
    }

    [Fact]
    public async Task Metrics_are_not_public_by_default()
    {
        using var f = Factory();
        var res = await f.CreateClient().GetAsync("/api/metrics"); // test client is not a loopback address
        Assert.Equal(System.Net.HttpStatusCode.NotFound, res.StatusCode);
        using var open = Factory(("Security:PublicMetrics", "true"));
        Assert.True((await open.CreateClient().GetAsync("/api/metrics")).IsSuccessStatusCode);
    }

    [Fact]
    public async Task Flooding_game_actions_is_rate_limited()
    {
        using var f = Factory();
        await using var c = await Connect(f);
        Assert.True((await c.InvokeAsync<OpResult>("CreateRoom", "Flooder", false)).Ok);
        var results = new List<OpResult>();
        for (int i = 0; i < 60; i++) results.Add(await c.InvokeAsync<OpResult>("SetReady", i % 2 == 0));
        Assert.Contains(results, r => r.Code == ErrorCodes.RateLimited);
        Assert.True(results.Count(r => r.Ok) is > 5 and < 40, $"{results.Count(r => r.Ok)} allowed");
    }

    [Fact]
    public async Task Guessing_room_codes_is_throttled()
    {
        using var f = Factory();
        await using var c = await Connect(f);
        var codes = new List<string?>();
        for (int i = 0; i < 12; i++) codes.Add((await c.InvokeAsync<OpResult>("JoinRoom", $"ZZZZ{"23456789ABCD"[i]}", "Guesser")).Code);
        Assert.Contains(ErrorCodes.NotFound, codes);
        Assert.Contains(ErrorCodes.RateLimited, codes);
        Assert.True(codes.Count(x => x == ErrorCodes.NotFound) <= 6);
    }

    [Fact]
    public async Task Room_creation_is_capped()
    {
        using var f = Factory(("Security:MaxRooms", "2"), ("Security:LobbyRate", "50"));
        await using var a = await Connect(f);
        await using var b = await Connect(f);
        await using var c = await Connect(f);
        Assert.True((await a.InvokeAsync<OpResult>("CreateRoom", "A", false)).Ok);
        Assert.True((await b.InvokeAsync<OpResult>("CreateVsComputer", "B", "Easy", 1)).Ok);
        var third = await c.InvokeAsync<OpResult>("CreateRoom", "C", false);
        Assert.Equal(ErrorCodes.ServerBusy, third.Code);
    }

    [Fact]
    public async Task Too_many_connections_from_one_address_are_refused()
    {
        using var f = Factory(("Security:MaxConnectionsPerIp", "2"));
        await using var a = await Connect(f);
        await using var b = await Connect(f);
        var closed = new TaskCompletionSource();
        await using var c = await Connect(f).ContinueWith(t => t.Result);
        c.Closed += _ => { closed.TrySetResult(); return Task.CompletedTask; };
        var done = await Task.WhenAny(closed.Task, Task.Delay(5000));
        Assert.True(done == closed.Task || c.State != HubConnectionState.Connected, "third connection from the same address stayed open");
        Assert.Equal(HubConnectionState.Connected, a.State);
    }

    [Theory]
    [InlineData("Ka‮admin")]   // right-to-left override
    [InlineData("Ka​vin")]    // zero-width space
    [InlineData("Bad\u0007")]      // control character
    [InlineData("<img>")]
    public void Spoofing_names_are_rejected(string name) => Assert.Null(Room.ValidateName(name));

    [Theory]
    [InlineData("Kavin")]
    [InlineData("கவின்")]           // Tamil
    [InlineData("க்‌ஷ")]       // Tamil with ZWNJ stays allowed
    public void Real_names_are_accepted(string name) => Assert.NotNull(Room.ValidateName(name));

    [Fact]
    public void Seat_tokens_are_long_random_and_bots_cannot_be_claimed()
    {
        var room = new Room("SEC01", RoomMode.VsComputer, GameConfig.Default, FieldLayout.Default, new Random(1), Difficulty.Easy, 2);
        room.AddPlayer("Kavin", "c1", out var human);
        Assert.Equal(32, human!.Token.Length); // 128-bit, hex
        var wrong = new string(human.Token.Select(ch => ch == 'a' ? 'b' : 'a').ToArray()); // same length, every character different
        Assert.Equal(ErrorCodes.BadToken, room.Reconnect(human.Id, wrong, "x").Code);
        Assert.Equal(ErrorCodes.BadToken, room.Reconnect(human.Id, "short", "x").Code);
        Assert.True(room.Reconnect(human.Id, human.Token, "x").Ok);
        var bot = room.Players.First(p => p.IsBot);
        Assert.Equal(ErrorCodes.BadToken, room.Reconnect(bot.Id, bot.Token, "x").Code);
    }

    [Fact]
    public void Catch_spam_is_on_cooldown()
    {
        var room = new Room("SEC02", false, GameConfig.Default, FieldLayout.Default, new Random(2));
        room.AddPlayer("A", "a", out var a); room.AddPlayer("B", "b", out var b);
        room.SetReady(b!.Id, true); room.StartMatch(a!.Id);
        room.ChooseToss(room.BuildState().Toss!.ChooserId, room.Find(room.BuildState().Toss!.ChooserId)!.Team == Gilli.Core.Rules.Team.A);
        room.Flick(a.Id, room.AttemptId);
        Assert.True(room.Catch(b.Id, room.AttemptId).Ok);
        Assert.Equal(ErrorCodes.Duplicate, room.Catch(b.Id, room.AttemptId).Code);
    }
}
