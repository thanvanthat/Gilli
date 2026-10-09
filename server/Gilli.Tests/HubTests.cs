using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;
using Gilli.Core.Rooms;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace Gilli.Tests;

/// <summary>End-to-end: two independent SignalR clients against the real ASP.NET Core server.</summary>
public class HubTests : IClassFixture<WebApplicationFactory<Program>>
{
    readonly WebApplicationFactory<Program> factory;
    public HubTests(WebApplicationFactory<Program> factory) => this.factory = factory;

    sealed class Client : IAsyncDisposable
    {
        public HubConnection Conn = null!;
        public readonly ConcurrentQueue<RoomStateDto> States = new();
        public readonly ConcurrentQueue<GameEvent> Events = new();
        public RoomStateDto? Latest => States.LastOrDefault();
        public ValueTask DisposeAsync() => Conn.DisposeAsync();
    }

    Task<Client> Connect() => Connect(factory);

    static async Task<Client> Connect(WebApplicationFactory<Program> factory)
    {
        var c = new Client();
        c.Conn = new HubConnectionBuilder()
            .WithUrl(new Uri(factory.Server.BaseAddress, "/hubs/game"), o =>
            {
                o.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
            })
            .AddJsonProtocol(o => o.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter()))
            .Build();
        c.Conn.On<RoomStateDto>("State", s => c.States.Enqueue(s));
        c.Conn.On<GameEvent>("Event", e => c.Events.Enqueue(e));
        await c.Conn.StartAsync();
        return c;
    }

    static T Data<T>(OpResult r) => ((JsonElement)r.Data!).Deserialize<T>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    static async Task Eventually(Func<bool> cond, string what)
    {
        for (int i = 0; i < 100; i++) { if (cond()) return; await Task.Delay(50); }
        Assert.Fail("timed out waiting for " + what);
    }

    [Fact]
    public async Task Health_and_layout_endpoints_respond()
    {
        var http = factory.CreateClient();
        var health = await http.GetStringAsync("/health");
        Assert.Contains("\"status\":\"ok\"", health);
        var layout = await http.GetStringAsync("/api/layout");
        Assert.Contains("\"obstacles\"", layout);
        Assert.Contains("\"Palm\"", layout);
    }

    [Fact]
    public async Task Two_browsers_create_join_see_each_other_and_receive_the_same_authoritative_result()
    {
        await using var host = await Connect();
        await using var guest = await Connect();

        var created = await host.Conn.InvokeAsync<OpResult>("CreateRoom", "Host", false);
        Assert.True(created.Ok, created.Error);
        var hostJoin = Data<JoinResultDto>(created);
        Assert.Equal(5, hostJoin.RoomCode.Length);

        var bad = await guest.Conn.InvokeAsync<OpResult>("JoinRoom", "ZZZZ9", "Guest");
        Assert.False(bad.Ok);
        Assert.Equal(ErrorCodes.NotFound, bad.Code);
        var malformed = await guest.Conn.InvokeAsync<OpResult>("JoinRoom", "!!", "Guest");
        Assert.Equal(ErrorCodes.InvalidCode, malformed.Code);

        var joined = await guest.Conn.InvokeAsync<OpResult>("JoinRoom", hostJoin.RoomCode.ToLowerInvariant(), "Guest");
        Assert.True(joined.Ok, joined.Error);
        var guestJoin = Data<JoinResultDto>(joined);
        Assert.NotEqual(hostJoin.PlayerId, guestJoin.PlayerId);

        // both clients must receive the broadcast (on fast machines the host's copy can arrive first)
        await Eventually(() => host.Latest?.Players.Count == 2 && guest.Latest?.Players.Count == 2, "both clients see two players");

        // only the host may start; guest must be ready
        Assert.Equal(ErrorCodes.NotHost, (await guest.Conn.InvokeAsync<OpResult>("StartMatch")).Code);
        Assert.Equal(ErrorCodes.NotReady, (await host.Conn.InvokeAsync<OpResult>("StartMatch")).Code);
        Assert.True((await guest.Conn.InvokeAsync<OpResult>("SetReady", true)).Ok);
        Assert.True((await host.Conn.InvokeAsync<OpResult>("StartMatch")).Ok);
        await Eventually(() => guest.Latest?.Phase == "Toss", "toss");

        var toss = guest.Latest!.Toss!;
        var chooser = toss.ChooserId == hostJoin.PlayerId ? host : guest;
        Assert.True((await chooser.Conn.InvokeAsync<OpResult>("ChooseToss", true)).Ok);
        await Eventually(() => host.Latest?.Phase == "Playing" && guest.Latest?.Phase == "Playing", "playing");

        var match = host.Latest!.Match!;
        var batter = match.BatterId == hostJoin.PlayerId ? host : guest;
        var fielder = batter == host ? guest : host;
        Assert.Equal(ErrorCodes.NotYourTurn, (await fielder.Conn.InvokeAsync<OpResult>("Flick", match.AttemptId)).Code);
        Assert.True((await batter.Conn.InvokeAsync<OpResult>("Flick", match.AttemptId)).Ok);
        // no swing: the gilli drops -> both clients get the same miss
        await Eventually(() => host.Events.Any(e => e.Type == "result") && guest.Events.Any(e => e.Type == "result"), "result events");
        await Eventually(() => host.Latest?.Match?.LastResult is not null && guest.Latest?.Match?.LastResult is not null, "result state");
        var hr = host.Latest!.Match!.LastResult!;
        var gr = guest.Latest!.Match!.LastResult!;
        Assert.Equal("Miss", hr.Outcome);
        Assert.Equal(hr, gr with { Landing = hr.Landing, Rest = hr.Rest });
        Assert.Equal(1, host.Latest.Match.Misses);
        Assert.Equal(host.Latest.Match.Scores, guest.Latest.Match.Scores);

        // full room: two more join, a fifth is rejected
        await using var c3 = await Connect();
        await using var c4 = await Connect();
        await using var c5 = await Connect();
        Assert.Equal(ErrorCodes.InProgress, (await c3.Conn.InvokeAsync<OpResult>("JoinRoom", hostJoin.RoomCode, "Late")).Code);
    }

    [Fact]
    public async Task Vs_computer_rooms_start_immediately_and_survive_the_game_loop()
    {
        // regression: the 60 Hz loop once closed a room in the instant between creating it and seating its creator
        // (own server with a relaxed lobby rate limit: this test creates rooms back to back on purpose)
        using var relaxed = factory.WithWebHostBuilder(b => b.UseSetting("Security:LobbyRate", "100"));
        await using var c = await Connect(relaxed);
        for (int i = 0; i < 15; i++)
        {
            var created = await c.Conn.InvokeAsync<OpResult>("CreateVsComputer", "Solo", i % 3 == 0 ? "Easy" : "Hard", 1 + i % 3);
            Assert.True(created.Ok, created.Error);
            var start = await c.Conn.InvokeAsync<OpResult>("StartMatch");
            Assert.True(start.Ok, $"run {i}: {start.Code} {start.Error}");
        }
        Assert.Equal(ErrorCodes.Invalid, (await c.Conn.InvokeAsync<OpResult>("CreateVsComputer", "Solo", "Impossible", 1)).Code);
        Assert.Equal(ErrorCodes.Invalid, (await c.Conn.InvokeAsync<OpResult>("CreateVsComputer", "Solo", "Easy", 9)).Code);
    }

    [Fact]
    public async Task Fifth_player_is_rejected_and_disconnect_updates_the_lobby()
    {
        var clients = new List<Client>();
        for (int i = 0; i < 5; i++) clients.Add(await Connect());
        try
        {
            var code = Data<JoinResultDto>(await clients[0].Conn.InvokeAsync<OpResult>("CreateRoom", "P1", false)).RoomCode;
            for (int i = 1; i < 4; i++) Assert.True((await clients[i].Conn.InvokeAsync<OpResult>("JoinRoom", code, $"P{i + 1}")).Ok);
            var full = await clients[4].Conn.InvokeAsync<OpResult>("JoinRoom", code, "P5");
            Assert.Equal(ErrorCodes.Full, full.Code);

            await clients[3].Conn.StopAsync();
            await Eventually(() => clients[0].Latest?.Players.Count(p => !p.Connected) == 1, "disconnect shown in lobby");

            var rooms = factory.Services.GetRequiredService<Gilli.Server.RoomManager>();
            Assert.NotNull(rooms.Get(code));
        }
        finally { foreach (var c in clients) await c.DisposeAsync(); }
    }
}
