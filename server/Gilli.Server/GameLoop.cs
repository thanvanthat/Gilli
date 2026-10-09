using System.Diagnostics;
using System.Text.Json;
using Gilli.Core.Rooms;

namespace Gilli.Server;

/// <summary>Live performance numbers, exposed on /api/metrics so they are measured rather than guessed.</summary>
public sealed class LoopMetrics
{
    readonly object gate = new();
    double tickSum, tickMax, tickLast;
    long ticks, snapshots, snapshotBytes;
    int lastSnapshotSize;

    public void RecordTick(double ms)
    {
        lock (gate) { ticks++; tickSum += ms; tickLast = ms; if (ms > tickMax) tickMax = ms; }
    }
    public void RecordSnapshot(int bytes)
    {
        lock (gate) { snapshots++; snapshotBytes += bytes; lastSnapshotSize = bytes; }
    }
    public object Read(int rooms) { lock (gate) return new
    {
        rooms, ticks, tickAvgMs = ticks == 0 ? 0 : Math.Round(tickSum / ticks, 4), tickMaxMs = Math.Round(tickMax, 3), tickLastMs = Math.Round(tickLast, 4),
        snapshots, snapshotAvgBytes = snapshots == 0 ? 0 : snapshotBytes / snapshots, lastSnapshotBytes = lastSnapshotSize,
    }; }
}

/// <summary>
/// Drives every room at 60 Hz (physics runs inside at a fixed 120 Hz step, substepped during swings)
/// and streams snapshots: 30 Hz while the gilli is moving, 10 Hz otherwise.
/// </summary>
public sealed class GameLoop(RoomManager rooms, Broadcaster broadcaster, LoopMetrics metrics, ILogger<GameLoop> log) : BackgroundService
{
    const double TickSeconds = 1.0 / 60;
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    readonly Dictionary<string, double> lastSnapshot = new();
    readonly Dictionary<string, double> abandonedSince = new();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(TickSeconds));
        var clock = Stopwatch.StartNew();
        double last = clock.Elapsed.TotalSeconds;
        long sampleCounter = 0;
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            double now = clock.Elapsed.TotalSeconds;
            double dt = now - last;
            last = now;
            foreach (var room in rooms.Rooms.ToList())
            {
                try
                {
                    var t0 = Stopwatch.GetTimestamp();
                    SnapshotDto? snap = null;
                    bool abandoned, empty;
                    lock (room.Sync)
                    {
                        room.Tick(dt);
                        double interval = room.HighRate ? 1.0 / 30 : 1.0 / 10;
                        lastSnapshot.TryGetValue(room.Code, out var prev);
                        if (now - prev >= interval - 0.002)
                        {
                            snap = room.BuildSnapshot();
                            lastSnapshot[room.Code] = now;
                        }
                        abandoned = room.IsAbandoned;
                        // a brand-new room is registered a moment before its creator is seated: never treat that as empty
                        empty = !room.HasHumans && room.Now > 10;
                    }
                    metrics.RecordTick(Stopwatch.GetElapsedTime(t0).TotalMilliseconds);
                    if (snap is not null)
                    {
                        if (++sampleCounter % 30 == 0) metrics.RecordSnapshot(JsonSerializer.SerializeToUtf8Bytes(snap, Json).Length);
                        await broadcaster.Snapshot(room, snap);
                    }
                    await broadcaster.Flush(room);

                    // close rooms nobody is connected to
                    if (empty) { Close(room, "empty"); continue; }
                    if (abandoned)
                    {
                        if (!abandonedSince.TryGetValue(room.Code, out var since)) abandonedSince[room.Code] = now;
                        else if (now - since > 120) Close(room, "abandoned");
                    }
                    else abandonedSince.Remove(room.Code);
                }
                catch (Exception ex)
                {
                    log.LogError(ex, "Tick failed for room {Room}", room.Code);
                }
            }
        }
    }

    void Close(Room room, string why)
    {
        rooms.Remove(room);
        lastSnapshot.Remove(room.Code);
        abandonedSince.Remove(room.Code);
        log.LogInformation("Room {Room} closed ({Why})", room.Code, why);
    }
}
