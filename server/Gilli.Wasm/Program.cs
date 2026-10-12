using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using System.Text.Json.Serialization;
using Gilli.Core;
using Gilli.Core.Rooms;
using Gilli.Core.Rules;

// Entry point required by the WebAssembly SDK; the browser drives the engine through the exports below.
Console.WriteLine("Gilli engine (C# WebAssembly) loaded");

/// <summary>
/// In-browser host for the authoritative C# room (same code the multiplayer server runs).
/// JSON in and out uses the SignalR hub's shapes (camelCase, enums as strings), so the browser client
/// treats it exactly like the server. One room at a time; the browser calls Tick at ~60 Hz.
/// </summary>
public static partial class Engine
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
    static Room? room;
    static string playerId = "";
    static int codeCounter;

    static string Out(object o) => JsonSerializer.Serialize(o, Json);

    [JSExport]
    public static string Layout()
    {
        var l = FieldLayout.Default;
        return Out(new
        {
            pit = new { x = 0, z = 0 },
            boundary = new { x = l.BoundaryCenter.X, z = l.BoundaryCenter.Y, radius = l.BoundaryRadius },
            walkRadius = l.WalkRadius,
            obstacles = l.Obstacles,
        });
    }

    /// <summary>mode: Practice or VsComputer. Returns an OpResult whose data is a JoinResult.</summary>
    [JSExport]
    public static string Create(string mode, string name, string difficulty, int teamSize)
    {
        if (!Enum.TryParse<RoomMode>(mode, true, out var m) || m == RoomMode.Online) return Out(OpResult.Fail(ErrorCodes.Invalid, "Only single-player rooms run in the browser."));
        if (!Enum.TryParse<Difficulty>(difficulty, true, out var level) || !Enum.IsDefined(level)) return Out(OpResult.Fail(ErrorCodes.Invalid, "Difficulty must be Easy, Normal or Hard."));
        if (teamSize is < 1 or > 3) return Out(OpResult.Fail(ErrorCodes.Invalid, "Players per team must be 1, 2 or 3."));
        room?.Dispose();
        room = new Room($"SOLO{++codeCounter % 10}", m, GameConfig.Default, FieldLayout.Default, null, level, teamSize);
        var r = room.AddPlayer(name, "local", out var p);
        if (!r.Ok) { room.Dispose(); room = null; return Out(r); }
        playerId = p!.Id;
        return Out(OpResult.Success(new JoinResultDto(room.Code, p.Id, p.Token, room.BuildState(broadcast: false))));
    }

    /// <summary>Peer-to-peer online game: this browser hosts the authoritative room under the given code.</summary>
    [JSExport]
    public static string CreateOnline(string code, string name)
    {
        room?.Dispose();
        room = new Room(code, RoomMode.Online, GameConfig.Default, FieldLayout.Default);
        var r = room.AddPlayer(name, "host", out var p);
        if (!r.Ok) { room.Dispose(); room = null; return Out(r); }
        playerId = p!.Id;
        return Out(OpResult.Success(new JoinResultDto(room.Code, p.Id, p.Token, room.BuildState(broadcast: false))));
    }

    /// <summary>Seat a remote player (a guest connected to this host); same validation as the server's JoinRoom.</summary>
    [JSExport]
    public static string Join(string name, string connectionId)
    {
        if (room is null || room.Mode != RoomMode.Online) return Out(OpResult.Fail(ErrorCodes.NotFound, "That room has closed."));
        var r = room.AddPlayer(name, connectionId, out var p);
        return Out(r.Ok ? OpResult.Success(new JoinResultDto(room.Code, p!.Id, p.Token, room.BuildState(broadcast: false))) : r);
    }

    /// <summary>A guest's connection dropped: show them offline (seat kept for the grace period).</summary>
    [JSExport]
    public static void Disconnect(string guestPlayerId) => room?.MarkDisconnected(guestPlayerId);

    /// <summary>Hub-style method call for this browser's own player.</summary>
    [JSExport]
    public static string Call(string method, string argsJson) => CallAs(playerId, method, argsJson);

    /// <summary>Hub-style method call on behalf of a player (the host relays guests' actions here).</summary>
    [JSExport]
    public static string CallAs(string actingPlayerId, string method, string argsJson)
    {
        if (room is null) return Out(OpResult.Fail(ErrorCodes.NotInRoom, "No game is running."));
        if (room.Find(actingPlayerId) is not { Left: false }) return Out(OpResult.Fail(ErrorCodes.NotInRoom, "You are no longer in this room."));
        var playerId = actingPlayerId;
        var a = JsonDocument.Parse(argsJson).RootElement;
        float F(int i) => a[i].GetSingle();
        var r = method switch
        {
            "SetReady" => room.SetReady(playerId, a[0].GetBoolean()),
            "StartMatch" => room.StartMatch(playerId),
            "ChooseToss" => room.ChooseToss(playerId, a[0].GetBoolean()),
            "PlayAgain" => room.PlayAgain(playerId),
            "BackToLobby" => room.BackToLobby(playerId),
            "Aim" => room.Aim(playerId, F(0)),
            "Flick" => room.Flick(playerId, a[0].GetInt32()),
            "Swing" => room.Swing(playerId, a[0].GetInt32()),
            "Catch" => room.Catch(playerId, a[0].GetInt32()),
            "Throw" => room.Throw(playerId, a[0].GetInt32(), F(1), F(2), F(3)),
            "Move" => room.Move(playerId, F(0), F(1), F(2), a[3].GetInt32()),
            "SetTeam" => Enum.TryParse<Team>(a[0].GetString(), true, out var t) ? room.SetTeam(playerId, t) : OpResult.Fail(ErrorCodes.Invalid, "Team must be A or B."),
            "LeaveRoom" => playerId == Engine.playerId ? Leave() : LeaveGuest(playerId),
            _ => OpResult.Fail(ErrorCodes.Invalid, $"{method} is not available here."),
        };
        return Out(r);
    }

    static OpResult LeaveGuest(string guest)
    {
        room!.Leave(guest);
        return OpResult.Success();
    }

    static OpResult Leave()
    {
        room?.Dispose();
        room = null;
        return OpResult.Success();
    }

    /// <summary>Advance the simulation; returns {now, state?, events[], snapshot?}.</summary>
    [JSExport]
    public static string Tick(double dt)
    {
        if (room is null) return "null";
        room.Tick(dt);
        var events = room.DrainEvents();
        var state = room.StateDirty ? room.BuildState() : null;
        return Out(new { now = room.Now, state, events, snapshot = room.BuildSnapshot() });
    }
}
