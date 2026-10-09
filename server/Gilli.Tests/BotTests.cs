using Gilli.Core;
using Gilli.Core.Rooms;
using Gilli.Core.Rules;
using Xunit.Abstractions;

namespace Gilli.Tests;

/// <summary>Single-player mode: CPU bots bat, field, catch and throw through the normal validated actions.</summary>
public class BotTests(ITestOutputHelper output)
{
    const double Dt = 1.0 / 60;

    static (Room room, Player human) VsComputer(Difficulty level, int teamSize, int seed)
    {
        var room = new Room("SOLO1", RoomMode.VsComputer, GameConfig.Default, FieldLayout.Default, new Random(seed), level, teamSize);
        Assert.True(room.AddPlayer("Kavin", "c1", out var human).Ok);
        return (room, human!);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void Creates_cpu_players_for_both_sides(int size)
    {
        var (room, human) = VsComputer(Difficulty.Normal, size, 1);
        Assert.Equal(Team.A, human.Team);
        Assert.Equal(size - 1, room.Players.Count(p => p.IsBot && p.Team == Team.A));
        Assert.Equal(size, room.Players.Count(p => p.IsBot && p.Team == Team.B));
        Assert.All(room.Players.Where(p => p.IsBot), b => Assert.EndsWith("(CPU)", b.Name));
        // only one human seat
        Assert.Equal(ErrorCodes.Full, room.AddPlayer("Intruder", "c2", out _).Code);
        // bots cannot be taken over with a reconnect
        var bot = room.Players.First(p => p.IsBot);
        Assert.Equal(ErrorCodes.BadToken, room.Reconnect(bot.Id, bot.Token, "evil").Code);
    }

    [Fact]
    public void Cpu_toss_winner_decides_by_itself()
    {
        for (int seed = 0; seed < 20; seed++)
        {
            var (room, human) = VsComputer(Difficulty.Normal, 1, seed);
            Assert.True(room.StartMatch(human.Id).Ok);
            Assert.Equal(RoomPhase.Toss, room.Phase);
            var toss = room.BuildState().Toss!;
            if (toss.ChooserId == human.Id) continue;
            for (int i = 0; i < 200 && room.Phase == RoomPhase.Toss; i++) room.Tick(Dt);
            Assert.Equal(RoomPhase.Playing, room.Phase); // within ~3 s, long before the 15 s timeout
            return;
        }
        Assert.Fail("the CPU never won a toss in 20 seeds");
    }

    /// <summary>The human never acts: the CPU must still bat, field, throw and finish the match on its own.</summary>
    [Theory]
    [InlineData(Difficulty.Easy, 1)]
    [InlineData(Difficulty.Normal, 2)]
    [InlineData(Difficulty.Hard, 3)]
    public void Cpu_plays_a_whole_match_with_real_physics(Difficulty level, int size)
    {
        var (room, human) = VsComputer(level, size, 7);
        room.StartMatch(human.Id);
        var events = new List<GameEvent>();
        for (double t = 0; t < 900 && room.Phase != RoomPhase.Finished; t += Dt)
        {
            room.Tick(Dt);
            var st = room.Phase == RoomPhase.Toss ? room.BuildState().Toss : null;
            if (st is { Choice: null } && st.ChooserId == human.Id) room.ChooseToss(human.Id, false); // human fields first
            events.AddRange(room.DrainEvents());
        }
        Assert.Equal(RoomPhase.Finished, room.Phase);
        int count(string type) => events.Count(e => e.Type == type);
        var results = events.Where(e => e.Type == "result").Select(e => (ResultDto)e.Data!["result"]!).ToList();
        output.WriteLine($"{level}: flicks {count("flick")}, swings {count("swing")}, hits {count("hit")}, catches {count("caught")}, throws {count("throw")}, target hits {count("targetHit")}, scores {string.Join("-", room.Rules!.Scores)}");
        foreach (var r in results.Take(12)) output.WriteLine($"  {r.Outcome} {r.OutKind} {r.Distance:F1} m +{r.Points} · {r.Reason}");

        Assert.True(count("swing") > 0, "CPU batters never swung");
        Assert.True(count("hit") > 0, "CPU batters never connected");
        // every CPU batter's attempts resolved; the human's (who never flicked) count as timeouts only on Team A
        Assert.All(results.Where(r => r.Team == "B"), r => Assert.DoesNotContain("Took too long", r.Reason));
        // the batting score equals the sum of the safe hits: nothing double counted
        Assert.Equal(results.Where(r => r.Team == "B").Sum(r => r.Points), room.Rules.Scores[1]);
    }

    [Fact]
    public void Cpu_fielders_catch_and_throw_when_the_human_bats()
    {
        int catches = 0, throws = 0, safe = 0;
        for (int seed = 0; seed < 6; seed++)
        {
            var (room, human) = VsComputer(Difficulty.Hard, 3, seed);
            room.StartMatch(human.Id);
            for (int i = 0; i < 400 && room.Phase == RoomPhase.Toss; i++)
            {
                var toss = room.BuildState().Toss!;
                if (toss.Choice is null && toss.ChooserId == human.Id) room.ChooseToss(human.Id, true);
                room.Tick(Dt);
            }
            for (int attempt = 0; attempt < 8 && room.Phase == RoomPhase.Playing && room.Rules!.CurrentBatter == human.Id; attempt++)
            {
                for (int i = 0; i < 600 && room.AttemptPhase != AttemptPhase.Ready; i++) room.Tick(Dt);
                if (room.Rules.CurrentBatter != human.Id) break;
                room.Flick(human.Id, room.AttemptId);
                for (double t = 0; t < 0.29; t += Dt) room.Tick(Dt);
                room.Swing(human.Id, room.AttemptId);
                for (int i = 0; i < 1500 && room.AttemptPhase != AttemptPhase.Result; i++) room.Tick(Dt);
                var ev = room.DrainEvents();
                if (ev.Any(e => e.Type == "caught")) catches++;
                if (ev.Any(e => e.Type == "throw")) throws++;
                if (ev.Any(e => e.Type == "result" && ((ResultDto)e.Data!["result"]!).Outcome == "Safe")) safe++;
            }
        }
        output.WriteLine($"catches {catches}, throws {throws}, safe {safe}");
        Assert.True(catches + throws > 0, "CPU fielders never caught or threw");
    }

    [Fact]
    public void Room_without_humans_is_empty_even_with_bots()
    {
        var (room, human) = VsComputer(Difficulty.Normal, 2, 3);
        Assert.True(room.HasHumans);
        room.Leave(human.Id);
        Assert.False(room.HasHumans);
        Assert.True(room.IsAbandoned);
    }
}
