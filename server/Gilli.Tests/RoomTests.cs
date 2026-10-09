using System.Numerics;
using Gilli.Core;
using Gilli.Core.Physics;
using Gilli.Core.Rooms;
using Gilli.Core.Rules;
using Xunit.Abstractions;

namespace Gilli.Tests;

public class RoomTests(ITestOutputHelper output)
{
    const double Dt = 1.0 / 60;
    // swing delay after the flick that gives a clean ~30 m drive (see PhysicsTests sweep)
    const double GoodSwingDelay = 0.28;

    static Room NewRoom(bool practice = false, int seed = 1, RulesConfig? rules = null) =>
        new("TEST1", practice, GameConfig.Default with { Rules = rules ?? new RulesConfig() }, FieldLayout.Default, new Random(seed));

    static Player Add(Room room, string name)
    {
        var r = room.AddPlayer(name, "conn-" + name, out var p);
        Assert.True(r.Ok, r.Error);
        return p!;
    }

    static void Run(Room room, double seconds) { for (double t = 0; t < seconds; t += Dt) room.Tick(Dt); }

    static void RunUntil(Room room, Func<bool> done, double max = 20)
    {
        for (double t = 0; t < max; t += Dt) { if (done()) return; room.Tick(Dt); }
        Assert.Fail($"timed out: phase {room.Phase}/{room.AttemptPhase}");
    }

    /// <summary>1 v 1 room already in play with <paramref name="batFirst"/> batting.</summary>
    static (Room room, Player a, Player b) StartedOneVsOne(RulesConfig? rules = null)
    {
        var room = NewRoom(rules: rules);
        var a = Add(room, "Arun");
        var b = Add(room, "Bala");
        Assert.Equal(Team.A, a.Team);
        Assert.Equal(Team.B, b.Team);
        room.SetReady(b.Id, true);
        Assert.True(room.StartMatch(a.Id).Ok);
        Assert.Equal(RoomPhase.Toss, room.Phase);
        var state = room.BuildState();
        var chooser = state.Toss!.ChooserId;
        Assert.True(room.ChooseToss(chooser, bat: room.Find(chooser)!.Team == Team.A).Ok); // Team A ends up batting
        Assert.Equal(RoomPhase.Playing, room.Phase);
        Assert.Equal(a.Id, room.Rules!.CurrentBatter);
        return (room, a, b);
    }

    static void GoodHit(Room room, Player batter)
    {
        Assert.True(room.Flick(batter.Id, room.AttemptId).Ok);
        Run(room, GoodSwingDelay);
        Assert.True(room.Swing(batter.Id, room.AttemptId).Ok);
        RunUntil(room, () => room.AttemptPhase != AttemptPhase.Popped, 2);
        Assert.Equal(AttemptPhase.InFlight, room.AttemptPhase);
    }

    [Fact]
    public void Clean_hit_with_no_fielder_scores_exactly_once_from_the_simulated_distance()
    {
        var room = NewRoom(practice: true);
        var p = Add(room, "Solo");
        Assert.True(room.StartMatch(p.Id).Ok);
        GoodHit(room, p);
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.Result);
        var s = room.BuildState().Match!;
        var r = s.LastResult!;
        output.WriteLine($"{r.Outcome} {r.Reason} dist {r.Distance} landing {s.Landing} rest {s.Rest} pts {r.Points}");
        Assert.Equal("Safe", r.Outcome);
        var rest = room.World!.Gilli.Position;
        Assert.InRange(r.Distance, 15, 45);
        Assert.Equal(MathF.Round(s.Rest!.Distance, 2), r.Distance, 2);
        Assert.Equal((int)Math.Floor(r.Distance / 0.75 + 1e-6), r.DistancePoints);
        Assert.Equal(r.DistancePoints + 1, r.Points);
        Assert.Equal(r.Points, s.Scores[0]);
        Assert.True(s.Landing!.Distance > 5 && s.Landing.Distance <= r.Distance + 0.01f);

        // the gilli keeps being simulated and the attempt keeps receiving physics events: no second score
        int score = s.Scores[0];
        Run(room, 2.5);
        Assert.Equal(score, room.Rules!.Scores[0]);
    }

    [Fact]
    public void Not_swinging_is_a_miss_and_three_in_a_row_is_out()
    {
        var (room, a, b) = StartedOneVsOne();
        for (int i = 1; i <= 3; i++)
        {
            Assert.True(room.Flick(a.Id, room.AttemptId).Ok);
            RunUntil(room, () => room.AttemptPhase == AttemptPhase.Result, 4);
            var r = room.BuildState().Match!.LastResult!;
            Assert.Equal(i < 3 ? "Miss" : "Out", r.Outcome);
            Assert.Equal(i, r.MissesAfter);
            Assert.Equal(0, r.Points);
            Assert.Equal(0, room.Rules!.Scores[0]);
            RunUntil(room, () => room.AttemptPhase == AttemptPhase.Ready, 5);
        }
        Assert.Equal(b.Id, room.Rules!.CurrentBatter);
        Assert.Equal(Team.B, room.Rules.BattingTeam);
    }

    [Fact]
    public void Swinging_far_too_late_misses()
    {
        var (room, a, _) = StartedOneVsOne();
        room.Flick(a.Id, room.AttemptId);
        Run(room, 0.75);
        room.Swing(a.Id, room.AttemptId);
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.Result, 4);
        var r = room.BuildState().Match!.LastResult!;
        Assert.Equal("Miss", r.Outcome);
        Assert.Contains("Swung and missed", r.Reason);
    }

    [Fact]
    public void Actions_are_validated_for_turn_phase_and_duplicates()
    {
        var (room, a, b) = StartedOneVsOne();
        int id = room.AttemptId;
        Assert.Equal(ErrorCodes.NotYourTurn, room.Flick(b.Id, id).Code);
        Assert.Equal(ErrorCodes.BadPhase, room.Swing(a.Id, id).Code);         // cannot swing before the flick
        Assert.Equal(ErrorCodes.Stale, room.Flick(a.Id, id + 5).Code);        // stale / forged attempt id
        Assert.True(room.Flick(a.Id, id).Ok);
        Assert.Equal(ErrorCodes.Duplicate, room.Flick(a.Id, id).Code);        // double flick
        Assert.True(room.Swing(a.Id, id).Ok);
        Assert.Equal(ErrorCodes.Duplicate, room.Swing(a.Id, id).Code);        // double swing
        Assert.Equal(ErrorCodes.NotYourTurn, room.Catch(a.Id, id).Code);      // batters cannot catch
        Assert.False(room.Throw(b.Id, id, 0, 0.5f, 0.5f).Ok);                 // nothing to throw yet
    }

    [Fact]
    public void A_fielder_in_position_who_presses_catch_gets_the_batter_out()
    {
        // find where a clean hit comes down at catching height, using an identical world
        Vector3 catchSpot;
        using (var w = new GilliWorld(new PhysicsConfig(), FieldLayout.Default))
        {
            w.ResetForAttempt(0);
            w.Flick();
            for (double t = 0; t < GoodSwingDelay - 1e-9; t += 1.0 / 120) w.Step();
            w.StartSwing();
            bool hit = false; catchSpot = default;
            for (int i = 0; i < 1200; i++)
            {
                hit |= w.Step().DandaHit;
                var g = w.Gilli;
                if (hit && g.Velocity.Y < 0 && g.Position.Y < 1.6f) { catchSpot = g.Position; break; }
            }
            Assert.True(hit);
        }
        output.WriteLine($"catch spot {catchSpot}");

        var (room, a, b) = StartedOneVsOne();
        b.Pos = new Vector2(catchSpot.X, catchSpot.Z);
        GoodHit(room, a);
        bool pressed = false;
        RunUntil(room, () =>
        {
            if (room.AttemptPhase != AttemptPhase.InFlight) return true;
            var g = room.World!.Gilli.Position;
            if (!pressed && g.Y < 2.4f && room.World.Gilli.Velocity.Y < 0) { Assert.True(room.Catch(b.Id, room.AttemptId).Ok); pressed = true; }
            return false;
        }, 6);
        var r = room.BuildState().Match!.LastResult!;
        Assert.Equal("Out", r.Outcome);
        Assert.Equal("Caught", r.OutKind);
        Assert.Equal(0, room.Rules!.Scores[0]);
    }

    [Fact]
    public void A_fielder_far_away_cannot_catch()
    {
        var (room, a, b) = StartedOneVsOne();
        b.Pos = new Vector2(30, -5);
        GoodHit(room, a);
        for (int i = 0; i < 40 && room.AttemptPhase == AttemptPhase.InFlight; i++) { room.Catch(b.Id, room.AttemptId); Run(room, 0.05); }
        Assert.NotEqual("Caught", room.BuildState().Match!.LastResult?.OutKind);
    }

    static float FindThrowPower(Vector3 release, float yaw, float pitch)
    {
        // pick the power whose simulated throw first lands closest to the pit
        float best = 0.5f, bestErr = float.MaxValue;
        using var w = new GilliWorld(new PhysicsConfig(), FieldLayout.Default);
        for (float power = 0; power <= 1.0001f; power += 0.005f)
        {
            w.Throw(release, yaw, pitch, power);
            for (int i = 0; i < 1200; i++)
            {
                var r = w.Step();
                if (r.GroundContact)
                {
                    float err = new Vector2(r.GroundPoint.X, r.GroundPoint.Z).Length();
                    if (err < bestErr) { bestErr = err; best = power; }
                    break;
                }
            }
        }
        return best;
    }

    [Fact]
    public void A_throw_that_reaches_the_danda_is_out_and_a_wild_throw_is_safe()
    {
        var (room, a, b) = StartedOneVsOne();
        GoodHit(room, a);
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.AwaitThrow, 12);
        var st = room.BuildState().Match!;
        Assert.Equal(b.Id, st.ThrowerId);
        Assert.True(st.TargetPresent);
        var rest = new Vector3(st.Rest!.X, 0, st.Rest.Z);
        float yaw = MathF.Atan2(-rest.X, -rest.Z), pitch = 0.6f;
        float power = FindThrowPower(rest with { Y = 1.5f }, yaw, pitch);
        output.WriteLine($"rest {rest} power {power}");
        Assert.True(room.Throw(b.Id, room.AttemptId, yaw, pitch, power).Ok);
        Assert.Equal(ErrorCodes.Duplicate, room.Throw(b.Id, room.AttemptId, yaw, pitch, power).Code);
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.Result, 8);
        var r = room.BuildState().Match!.LastResult!;
        Assert.Equal("Out", r.Outcome);
        Assert.Equal("TargetHit", r.OutKind);
        Assert.Equal(0, room.Rules!.Scores[0]);

        // Team B now bats; Arun fields and throws wide
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.Ready, 5);
        Assert.Equal(b.Id, room.Rules.CurrentBatter);
        GoodHit(room, b);
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.AwaitThrow, 12);
        st = room.BuildState().Match!;
        Assert.Equal(a.Id, st.ThrowerId);
        rest = new Vector3(st.Rest!.X, 0, st.Rest.Z);
        Assert.True(room.Throw(a.Id, room.AttemptId, MathF.Atan2(-rest.X, -rest.Z) + 0.8f, 0.5f, 0.4f).Ok);
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.Result, 8);
        r = room.BuildState().Match!.LastResult!;
        Assert.Equal("Safe", r.Outcome);
        Assert.True(r.Points > 1);
        // chase complete: B passed A's 0
        Assert.Equal(RoomPhase.Playing, room.Phase);
        Run(room, 4);
        Assert.Equal(RoomPhase.Finished, room.Phase);
        Assert.Equal(Team.B, room.Rules.Winner);
    }

    [Fact]
    public void Throw_timeout_counts_as_a_missed_throw()
    {
        var (room, a, b) = StartedOneVsOne();
        GoodHit(room, a);
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.AwaitThrow, 12);
        Run(room, new RulesConfig().ThrowTimeLimit + 0.5);
        var r = room.BuildState().Match!.LastResult!;
        Assert.Equal("Safe", r.Outcome);
        Assert.Contains("No throw", r.Reason);
    }

    [Fact]
    public void Complete_match_produces_winner_and_play_again_resets()
    {
        var (room, a, b) = StartedOneVsOne(new RulesConfig { MaxAttemptsPerBatter = 2, EndWhenChaseComplete = false });
        // A: one safe hit (throw timeout) then retires after 2 attempts
        GoodHit(room, a);
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.AwaitThrow, 12);
        Run(room, 16);
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.Ready, 5);
        room.Flick(a.Id, room.AttemptId); // miss: 2nd attempt, retires
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.Ready || room.Phase == RoomPhase.Finished, 8);
        int scoreA = room.Rules!.Scores[0];
        Assert.True(scoreA > 0);
        Assert.Equal(b.Id, room.Rules.CurrentBatter);
        // B: two misses, retires -> match over, A wins
        room.Flick(b.Id, room.AttemptId);
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.Ready, 8);
        room.Flick(b.Id, room.AttemptId);
        RunUntil(room, () => room.Phase == RoomPhase.Finished, 8);
        var state = room.BuildState();
        Assert.Equal("A", state.Match!.Winner);
        Assert.Equal(new[] { scoreA, 0 }, state.Match.Scores);

        Assert.Equal(ErrorCodes.NotHost, room.PlayAgain(b.Id).Code);
        Assert.True(room.PlayAgain(a.Id).Ok);
        Assert.Equal(RoomPhase.Toss, room.Phase);
        room.ChooseToss(room.BuildState().Toss!.ChooserId, true);
        Assert.Equal(new[] { 0, 0 }, room.Rules!.Scores);
        Assert.Equal(0, room.Rules.ConsecutiveMisses);
        Assert.Equal(1, room.Rules.AttemptNumber);
    }

    [Fact]
    public void Lobby_validates_names_capacity_teams_ready_and_host()
    {
        var room = NewRoom();
        Assert.Equal(ErrorCodes.InvalidName, room.AddPlayer("  ", "c0", out _).Code);
        Assert.Equal(ErrorCodes.InvalidName, room.AddPlayer("<script>", "c0", out _).Code);
        var p1 = Add(room, "Anbu");
        Assert.Equal(ErrorCodes.TeamsUneven, room.StartMatch(p1.Id).Code); // alone
        var p2 = Add(room, "Bharathi");
        Assert.Equal(ErrorCodes.NotHost, room.StartMatch(p2.Id).Code);
        Assert.Equal(ErrorCodes.NotReady, room.StartMatch(p1.Id).Code);
        var p3 = Add(room, "Chitra");
        var p4 = Add(room, "Devi");
        Assert.Equal(ErrorCodes.Full, room.AddPlayer("Elango", "c5", out _).Code);
        Assert.Equal(new[] { Team.A, Team.B, Team.A, Team.B }, new[] { p1.Team, p2.Team, p3.Team, p4.Team });
        Assert.Equal(ErrorCodes.TeamFull, room.SetTeam(p2.Id, Team.A).Code);
        foreach (var p in new[] { p2, p3, p4 }) room.SetReady(p.Id, true);
        Assert.True(room.StartMatch(p1.Id).Ok);
        Assert.Equal(ErrorCodes.InProgress, room.AddPlayer("Late", "c6", out _).Code);
    }

    [Fact]
    public void Disconnect_updates_lobby_then_removes_after_grace_and_migrates_host()
    {
        var room = NewRoom();
        var host = Add(room, "Host");
        var guest = Add(room, "Guest");
        room.MarkDisconnected(host.Id);
        var s = room.BuildState();
        Assert.False(s.Players.Single(p => p.Id == host.Id).Connected);
        Assert.True(room.Reconnect(host.Id, host.Token, "new-conn").Ok); // comes back in time
        Assert.Equal(ErrorCodes.BadToken, room.Reconnect(host.Id, "forged", "x").Code);
        room.MarkDisconnected(host.Id);
        Run(room, new RulesConfig().DisconnectGrace + 1);
        s = room.BuildState();
        Assert.Single(s.Players);
        Assert.Equal(guest.Id, s.HostId);
    }

    [Fact]
    public void Leaving_mid_match_forfeits_when_a_whole_side_is_gone()
    {
        var (room, a, b) = StartedOneVsOne();
        room.Leave(b.Id);
        Run(room, 0.1);
        Assert.Equal(RoomPhase.Finished, room.Phase);
        Assert.Equal(Team.A, room.Rules!.Winner);
    }

    [Fact]
    public void Event_texts_are_clean_utf8_without_mojibake()
    {
        // regression: a Windows-1252 round trip once turned "·" into "Â·" in server messages
        var (room, a, _) = StartedOneVsOne();
        room.Flick(a.Id, room.AttemptId);
        RunUntil(room, () => room.AttemptPhase == AttemptPhase.Result, 4);
        var texts = room.DrainEvents().Select(e => e.Text).ToList();
        Assert.Contains(texts, t => t.Contains("to bat · attempt"));
        Assert.Contains(texts, t => t.StartsWith("Miss · "));
        Assert.DoesNotContain(texts, t => t.Contains('Â') || t.Contains('Ã'));
    }

    [Fact]
    public void Movement_is_speed_limited_and_kept_out_of_solid_objects()
    {
        var (room, a, b) = StartedOneVsOne();
        var start = b.Pos;
        Run(room, 0.1);
        room.Move(b.Id, start.X + 50, start.Y, 0); // teleport attempt
        Assert.True(Vector2.Distance(start, b.Pos) < 3.0f, $"moved {Vector2.Distance(start, b.Pos)}");
        var neem = FieldLayout.Default.Obstacles.First(o => o.Kind == ObstacleKind.Neem);
        b.Pos = new Vector2(neem.X + 1, neem.Z);
        Run(room, 0.2);
        room.Move(b.Id, neem.X, neem.Z, 0);
        Assert.True(Vector2.Distance(b.Pos, new Vector2(neem.X, neem.Z)) >= neem.Radius + 0.39f);
        // the batter cannot walk away from the crease
        var batterPos = a.Pos;
        room.Move(a.Id, 5, -5, 0);
        Assert.Equal(batterPos, a.Pos);
    }
}
