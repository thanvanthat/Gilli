using System.Collections.Concurrent;
using System.Security.Cryptography;
using Gilli.Core;
using Gilli.Core.Rooms;

namespace Gilli.Server;

public readonly record struct Binding(string RoomCode, string PlayerId);

/// <summary>In-memory room registry and connection-to-player bindings.</summary>
public sealed class RoomManager
{
    const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
    public const int CodeLength = 5;

    readonly ConcurrentDictionary<string, Room> rooms = new();
    readonly ConcurrentDictionary<string, Binding> bindings = new();
    readonly GameConfig config;

    public RoomManager(GameConfig config) => this.config = config;

    public IEnumerable<Room> Rooms => rooms.Values;
    public int Count => rooms.Count;

    public static string? NormalizeCode(string? code)
    {
        code = code?.Trim().ToUpperInvariant();
        if (code is null || code.Length != CodeLength || code.Any(c => !Alphabet.Contains(c))) return null;
        return code;
    }

    public Room Create(bool practice) => Create(practice ? RoomMode.Practice : RoomMode.Online);

    public Room Create(RoomMode mode, Difficulty difficulty = Difficulty.Normal, int teamSize = 1)
    {
        while (true)
        {
            var code = string.Create(CodeLength, 0, (span, _) =>
            {
                for (int i = 0; i < span.Length; i++) span[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
            });
            var room = new Room(code, mode, config, null, null, difficulty, teamSize);
            if (rooms.TryAdd(code, room)) return room;
            room.Dispose();
        }
    }

    public Room? Get(string? code) => NormalizeCode(code) is { } c && rooms.TryGetValue(c, out var r) ? r : null;

    public void Remove(Room room)
    {
        if (rooms.TryRemove(room.Code, out _))
            lock (room.Sync) room.Dispose();
    }

    public void Bind(string connectionId, Room room, string playerId) => bindings[connectionId] = new Binding(room.Code, playerId);
    public bool TryGetBinding(string connectionId, out Binding binding) => bindings.TryGetValue(connectionId, out binding);
    public void Unbind(string connectionId) => bindings.TryRemove(connectionId, out _);
}
