using Gilli.Core;
using Gilli.Core.Rules;

namespace Gilli.Tests;

public class RulesTests
{
    static readonly RulesConfig Cfg = new() { DandaLength = 0.75f, SafeHitBonus = 1, MaxConsecutiveMisses = 3, MaxAttemptsPerBatter = 0, EndWhenChaseComplete = false };

    static MatchRules OneVsOne(RulesConfig? c = null, Team first = Team.A) => new(c ?? Cfg, new[] { "a1" }, new[] { "b1" }, first);
    static MatchRules TwoVsTwo(RulesConfig? c = null) => new(c ?? Cfg, new[] { "a1", "a2" }, new[] { "b1", "b2" }, Team.A);

    [Theory]
    [InlineData(0.0f, 0, 1)]
    [InlineData(0.74f, 0, 1)]
    [InlineData(0.75f, 1, 2)]
    [InlineData(1.5f, 2, 3)]
    [InlineData(27.4f, 36, 37)]   // 27.4 / 0.75 = 36.53
    [InlineData(30.0f, 40, 41)]
    public void Safe_hit_scores_floor_distance_over_danda_length_plus_bonus(float distance, int distPts, int total)
    {
        var m = OneVsOne();
        var r = m.RecordSafeHit(distance);
        Assert.Equal(AttemptOutcome.Safe, r.Outcome);
        Assert.Equal(distPts, r.DistancePoints);
        Assert.Equal(1, r.Bonus);
        Assert.Equal(total, r.Points);
        Assert.Equal(total, m.Scores[0]);
        Assert.Equal(0, m.Scores[1]);
    }

    [Fact]
    public void Miss_and_out_never_award_points()
    {
        var m = OneVsOne();
        m.RecordMiss("swung and missed");
        Assert.Equal(0, m.Scores[0]);
        var r = m.RecordCatch("B1");
        Assert.Equal(0, r.Points);
        Assert.Equal(0, m.Scores[0]);
    }

    [Fact]
    public void Three_consecutive_misses_is_out()
    {
        var m = OneVsOne();
        Assert.Equal(AttemptOutcome.Miss, m.RecordMiss("x").Outcome);
        Assert.Equal(AttemptOutcome.Miss, m.RecordMiss("x").Outcome);
        var r = m.RecordMiss("x");
        Assert.Equal(AttemptOutcome.Out, r.Outcome);
        Assert.Equal(OutKind.ThreeMisses, r.OutKind);
        Assert.Equal(3, r.MissesAfter);
        Assert.True(r.InningsEnded);
        Assert.Equal("b1", m.CurrentBatter);
        Assert.Equal(Team.B, m.BattingTeam);
    }

    [Fact]
    public void Safe_hit_resets_consecutive_misses_but_not_attempt_count()
    {
        var m = OneVsOne();
        m.RecordMiss("x");
        m.RecordMiss("x");
        Assert.Equal(2, m.ConsecutiveMisses);
        Assert.Equal(3, m.AttemptNumber);
        m.RecordSafeHit(10);
        Assert.Equal(0, m.ConsecutiveMisses);
        Assert.Equal(4, m.AttemptNumber);
        m.RecordMiss("x");
        m.RecordMiss("x");
        Assert.Equal("a1", m.CurrentBatter); // still in: misses were not consecutive
        Assert.Equal(6, m.AttemptNumber);
    }

    [Fact]
    public void Catch_is_out_and_target_hit_is_out()
    {
        var m = TwoVsTwo();
        var c = m.RecordCatch("Kavin");
        Assert.Equal(OutKind.Caught, c.OutKind);
        Assert.Equal("a2", m.CurrentBatter);
        var t = m.RecordTargetHit("Meena");
        Assert.Equal(OutKind.TargetHit, t.OutKind);
        Assert.True(t.InningsEnded);
        Assert.Equal("b1", m.CurrentBatter);
    }

    [Fact]
    public void Batting_order_and_innings_progress_through_every_player()
    {
        var m = TwoVsTwo();
        var order = new List<string>();
        while (!m.IsComplete)
        {
            order.Add(m.CurrentBatter!);
            m.RecordSafeHit(3);
            m.RecordOut(OutKind.Caught, "caught");
        }
        Assert.Equal(new[] { "a1", "a2", "b1", "b2" }, order);
    }

    [Fact]
    public void Match_completes_with_correct_winner_or_draw()
    {
        var m = OneVsOne();
        m.RecordSafeHit(15);   // 20 + 1 = 21
        m.RecordCatch("b1");
        m.RecordSafeHit(7.5f); // 10 + 1 = 11
        m.RecordTargetHit("a1");
        Assert.True(m.IsComplete);
        Assert.Equal(Team.A, m.Winner);
        Assert.Equal(new[] { 21, 11 }, m.Scores);

        var d = OneVsOne();
        d.RecordSafeHit(3); d.RecordCatch("b1");
        d.RecordSafeHit(3); d.RecordCatch("a1");
        Assert.True(d.IsComplete);
        Assert.Null(d.Winner);
    }

    [Fact]
    public void Chase_ends_match_as_soon_as_the_target_is_passed()
    {
        var m = OneVsOne(Cfg with { EndWhenChaseComplete = true });
        m.RecordSafeHit(3); // A: 5
        m.RecordCatch("b1");
        var r = m.RecordSafeHit(4.5f); // B: 7 > 5
        Assert.True(r.MatchEnded);
        Assert.True(m.IsComplete);
        Assert.True(m.ChaseCompleted);
        Assert.Equal(Team.B, m.Winner);
    }

    [Fact]
    public void Attempt_limit_retires_batter_so_innings_cannot_run_forever()
    {
        var m = OneVsOne(Cfg with { MaxAttemptsPerBatter = 4 });
        for (int i = 0; i < 3; i++) Assert.False(m.RecordSafeHit(2).BatterFinished);
        var r = m.RecordSafeHit(2);
        Assert.True(r.BatterFinished);
        Assert.Equal(OutKind.AttemptLimit, m.Stats["a1"].Out);
        Assert.Equal("b1", m.CurrentBatter);
    }

    [Fact]
    public void Toss_choice_decides_who_bats_first()
    {
        var m = OneVsOne(first: Team.B);
        Assert.Equal(Team.B, m.BattingTeam);
        Assert.Equal("b1", m.CurrentBatter);
    }

    [Fact]
    public void Solo_practice_side_skips_the_empty_innings()
    {
        var m = new MatchRules(Cfg, new[] { "solo" }, Array.Empty<string>(), Team.A);
        m.RecordSafeHit(10);
        m.RecordMiss("x"); m.RecordMiss("x"); m.RecordMiss("x");
        Assert.True(m.IsComplete);
        Assert.Equal(Team.A, m.Winner);
    }

    [Fact]
    public void Actions_after_completion_are_rejected()
    {
        var m = OneVsOne();
        m.RecordCatch("b1"); m.RecordCatch("a1");
        Assert.True(m.IsComplete);
        Assert.Throws<InvalidOperationException>(() => m.RecordSafeHit(10));
        Assert.Throws<InvalidOperationException>(() => m.RecordMiss("x"));
    }

    [Fact]
    public void Forfeit_awards_the_match_to_the_other_side()
    {
        var m = OneVsOne();
        m.Forfeit(Team.A);
        Assert.True(m.IsComplete);
        Assert.Equal(Team.B, m.Winner);
    }
}
