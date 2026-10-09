using Gilli.Core.Rooms;
using Microsoft.AspNetCore.SignalR;

namespace Gilli.Server;

/// <summary>Collects a room's pending state and events under its lock, then sends them outside the lock.</summary>
public sealed class Broadcaster(IHubContext<GameHub> hub, ILogger<Broadcaster> log)
{
    public static string Group(string code) => "room:" + code;

    public async Task Flush(Room room)
    {
        RoomStateDto? state;
        List<GameEvent> events;
        lock (room.Sync)
        {
            events = room.DrainEvents();
            state = room.StateDirty ? room.BuildState() : null;
        }
        var clients = hub.Clients.Group(Group(room.Code));
        try
        {
            if (state is not null) await clients.SendAsync("State", state);
            foreach (var e in events) await clients.SendAsync("Event", e);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Broadcast to room {Room} failed", room.Code);
        }
    }

    public Task Snapshot(Room room, SnapshotDto snapshot) => hub.Clients.Group(Group(room.Code)).SendAsync("Snapshot", snapshot);
}
