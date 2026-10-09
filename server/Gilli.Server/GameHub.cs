using Gilli.Core.Rooms;
using Gilli.Core.Rules;
using Microsoft.AspNetCore.SignalR;

namespace Gilli.Server;

/// <summary>
/// Real-time endpoint (/hubs/game). Clients only send inputs and intents (flick, swing, catch,
/// throw, movement); every outcome is decided by the room's authoritative simulation.
/// </summary>
public sealed class GameHub(RoomManager rooms, Broadcaster broadcaster, SecurityOptions security, ILogger<GameHub> log) : Hub
{
    public async Task<OpResult> CreateRoom(string name, bool practice)
    {
        await LeaveCurrent();
        if (Room.ValidateName(name) is null) return OpResult.Fail(ErrorCodes.InvalidName, "Enter a name of 1 to 16 characters.");
        if (rooms.Count >= security.MaxRooms) return OpResult.Fail(ErrorCodes.ServerBusy, "The server is full right now. Try again in a few minutes.");
        var room = rooms.Create(practice);
        log.LogInformation("Room {Room} created (practice={Practice})", room.Code, practice);
        return await JoinInternal(room, name);
    }

    /// <summary>Single player: you (plus CPU teammates) against a CPU side.</summary>
    public async Task<OpResult> CreateVsComputer(string name, string difficulty, int teamSize)
    {
        await LeaveCurrent();
        if (Room.ValidateName(name) is null) return OpResult.Fail(ErrorCodes.InvalidName, "Enter a name of 1 to 16 characters.");
        if (!Enum.TryParse<Difficulty>(difficulty, true, out var level) || !Enum.IsDefined(level)) return OpResult.Fail(ErrorCodes.Invalid, "Difficulty must be Easy, Normal or Hard.");
        if (teamSize is < 1 or > 3) return OpResult.Fail(ErrorCodes.Invalid, "Players per team must be 1, 2 or 3.");
        if (rooms.Count >= security.MaxRooms) return OpResult.Fail(ErrorCodes.ServerBusy, "The server is full right now. Try again in a few minutes.");
        var room = rooms.Create(RoomMode.VsComputer, level, teamSize);
        log.LogInformation("Room {Room} created (vs computer, {Level}, {Size} per team)", room.Code, level, teamSize);
        return await JoinInternal(room, name);
    }

    public async Task<OpResult> JoinRoom(string code, string name)
    {
        await LeaveCurrent();
        if (RoomManager.NormalizeCode(code) is null) return OpResult.Fail(ErrorCodes.InvalidCode, $"Room codes are {RoomManager.CodeLength} letters or digits.");
        var room = rooms.Get(code);
        if (room is null) return OpResult.Fail(ErrorCodes.NotFound, $"No room with code {code.Trim().ToUpperInvariant()}.");
        return await JoinInternal(room, name);
    }

    async Task<OpResult> JoinInternal(Room room, string name)
    {
        OpResult result;
        Player? player;
        RoomStateDto? state = null;
        lock (room.Sync)
        {
            result = room.AddPlayer(name, Context.ConnectionId, out player);
            if (result.Ok) state = room.BuildState(broadcast: false);
        }
        if (!result.Ok)
        {
            if (!room.HasHumans) rooms.Remove(room);
            return result;
        }
        rooms.Bind(Context.ConnectionId, room, player!.Id);
        await Groups.AddToGroupAsync(Context.ConnectionId, Broadcaster.Group(room.Code));
        await broadcaster.Flush(room);
        return OpResult.Success(new JoinResultDto(room.Code, player.Id, player.Token, state!));
    }

    /// <summary>Resume a seat after a dropped connection (new connection id, same player).</summary>
    public async Task<OpResult> Rejoin(string code, string playerId, string token)
    {
        var room = rooms.Get(code);
        if (room is null) return OpResult.Fail(ErrorCodes.NotFound, "That room no longer exists.");
        OpResult result;
        RoomStateDto? state = null;
        lock (room.Sync)
        {
            result = room.Reconnect(playerId, token, Context.ConnectionId);
            if (result.Ok) state = room.BuildState(broadcast: false);
        }
        if (!result.Ok) return result;
        rooms.Bind(Context.ConnectionId, room, playerId);
        await Groups.AddToGroupAsync(Context.ConnectionId, Broadcaster.Group(room.Code));
        await broadcaster.Flush(room);
        return OpResult.Success(new JoinResultDto(room.Code, playerId, token, state!));
    }

    public async Task<OpResult> LeaveRoom()
    {
        await LeaveCurrent();
        return OpResult.Success();
    }

    async Task LeaveCurrent()
    {
        if (!rooms.TryGetBinding(Context.ConnectionId, out var b)) return;
        rooms.Unbind(Context.ConnectionId);
        var room = rooms.Get(b.RoomCode);
        if (room is null) return;
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, Broadcaster.Group(room.Code));
        bool empty;
        lock (room.Sync)
        {
            room.Leave(b.PlayerId);
            empty = !room.HasHumans;
        }
        if (empty) { rooms.Remove(room); log.LogInformation("Room {Room} closed (empty)", room.Code); }
        else await broadcaster.Flush(room);
    }

    public Task<OpResult> SetTeam(string team) =>
        Act((room, pid) => Enum.TryParse<Team>(team, true, out var t) ? room.SetTeam(pid, t) : OpResult.Fail(ErrorCodes.Invalid, "Team must be A or B."));
    public Task<OpResult> SetReady(bool ready) => Act((room, pid) => room.SetReady(pid, ready));
    public Task<OpResult> StartMatch() => Act((room, pid) => room.StartMatch(pid));
    public Task<OpResult> ChooseToss(bool bat) => Act((room, pid) => room.ChooseToss(pid, bat));
    public Task<OpResult> PlayAgain() => Act((room, pid) => room.PlayAgain(pid));
    public Task<OpResult> BackToLobby() => Act((room, pid) => room.BackToLobby(pid));
    public Task<OpResult> Aim(float aim) => Act((room, pid) => room.Aim(pid, aim));
    public Task<OpResult> Flick(int attemptId) => Act((room, pid) => room.Flick(pid, attemptId));
    public Task<OpResult> Swing(int attemptId) => Act((room, pid) => room.Swing(pid, attemptId));
    public Task<OpResult> Catch(int attemptId) => Act((room, pid) => room.Catch(pid, attemptId));
    public Task<OpResult> Throw(int attemptId, float yaw, float pitch, float power) => Act((room, pid) => room.Throw(pid, attemptId, yaw, pitch, power));

    /// <summary>High-frequency movement input: no flush (positions travel in snapshots).</summary>
    public void Move(float x, float z, float yaw)
    {
        if (!rooms.TryGetBinding(Context.ConnectionId, out var b) || rooms.Get(b.RoomCode) is not { } room) return;
        lock (room.Sync) room.Move(b.PlayerId, x, z, yaw);
    }

    /// <summary>Clock sync: returns the room clock so clients can align snapshot time.</summary>
    public double Ping()
    {
        if (!rooms.TryGetBinding(Context.ConnectionId, out var b) || rooms.Get(b.RoomCode) is not { } room) return -1;
        lock (room.Sync) return room.Now;
    }

    async Task<OpResult> Act(Func<Room, string, OpResult> action)
    {
        if (!rooms.TryGetBinding(Context.ConnectionId, out var b)) return OpResult.Fail(ErrorCodes.NotInRoom, "You are not in a room.");
        var room = rooms.Get(b.RoomCode);
        if (room is null) return OpResult.Fail(ErrorCodes.NotFound, "That room no longer exists.");
        OpResult result;
        lock (room.Sync)
        {
            if (room.Find(b.PlayerId) is not { Left: false }) return OpResult.Fail(ErrorCodes.NotInRoom, "You are no longer in this room.");
            result = action(room, b.PlayerId);
        }
        await broadcaster.Flush(room);
        return result;
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (rooms.TryGetBinding(Context.ConnectionId, out var b))
        {
            rooms.Unbind(Context.ConnectionId);
            if (rooms.Get(b.RoomCode) is { } room)
            {
                lock (room.Sync)
                {
                    // only mark disconnected if this connection still owns the seat (it may have rejoined already)
                    if (room.Find(b.PlayerId) is { } p && p.ConnectionId == Context.ConnectionId) room.MarkDisconnected(b.PlayerId);
                }
                await broadcaster.Flush(room);
            }
        }
        await base.OnDisconnectedAsync(exception);
    }
}
