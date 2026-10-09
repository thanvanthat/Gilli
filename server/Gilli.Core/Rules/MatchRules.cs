namespace Gilli.Core.Rules;

public enum Team { A = 0, B = 1 }

public enum OutKind { None, ThreeMisses, Caught, TargetHit, Retired, AttemptLimit }

public enum AttemptOutcome { Miss, Safe, Out }

/// <summary>Result of one resolved attempt. Produced exactly once per attempt.</summary>
public sealed record AttemptResult
{
    public required AttemptOutcome Outcome { get; init; }
    public OutKind OutKind { get; init; }
    public required string BatterId { get; init; }
    public required Team Team { get; init; }
    public string Reason { get; init; } = "";
    public float Distance { get; init; }
    public int DistancePoints { get; init; }
    public int Bonus { get; init; }
    public int Points { get; init; }
    public int MissesAfter { get; init; }
    public int AttemptNumber { get; init; }
    /// <summary>Batter left the crease (out or retired).</summary>
    public bool BatterFinished { get; init; }
    public bool InningsEnded { get; init; }
    public bool MatchEnded { get; init; }
}

public sealed class PlayerStats
{
    public int Points { get; set; }
    public int SafeHits { get; set; }
    public float Longest { get; set; }
    public OutKind Out { get; set; }
    public bool HasBatted { get; set; }
}

/// <summary>
/// Pure, deterministic Gilli-Danda rules: batting order, attempts, consecutive misses, outs,
/// distance scoring, innings and the result. No physics or networking in here, so every rule is
/// unit-testable. The physics layer reports what happened; this class decides what it means.
/// </summary>
public sealed class MatchRules
{
    readonly RulesConfig cfg;
    readonly List<string>[] lineup;
    readonly int[] nextBatter = new int[2];
    readonly Team firstBatting;

    public int[] Scores { get; } = new int[2];
    public Dictionary<string, PlayerStats> Stats { get; } = new();
    public int InningsIndex { get; private set; }
    public int TotalInnings => cfg.InningsPerTeam * 2;
    public Team BattingTeam => InningsIndex % 2 == 0 ? firstBatting : Other(firstBatting);
    public Team FieldingTeam => Other(BattingTeam);
    public string? CurrentBatter { get; private set; }
    public int ConsecutiveMisses { get; private set; }
    /// <summary>1-based attempt number of the current batter.</summary>
    public int AttemptNumber { get; private set; } = 1;
    public bool IsComplete { get; private set; }
    /// <summary>Null when the match is drawn (or not complete).</summary>
    public Team? Winner { get; private set; }
    public bool ChaseCompleted { get; private set; }
    public IReadOnlyList<string> Lineup(Team t) => lineup[(int)t];
    public RulesConfig Config => cfg;

    public static Team Other(Team t) => t == Team.A ? Team.B : Team.A;

    public MatchRules(RulesConfig config, IEnumerable<string> teamA, IEnumerable<string> teamB, Team firstBatting)
    {
        cfg = config;
        lineup = new[] { teamA.ToList(), teamB.ToList() };
        this.firstBatting = firstBatting;
        foreach (var id in lineup[0].Concat(lineup[1])) Stats[id] = new PlayerStats();
        if (lineup[0].Count == 0 && lineup[1].Count == 0) throw new ArgumentException("A match needs at least one player.");
        StartInnings();
    }

    void StartInnings()
    {
        while (InningsIndex < TotalInnings)
        {
            int team = (int)BattingTeam;
            nextBatter[team] = 0;
            if (lineup[team].Count > 0) { BeginBatter(lineup[team][0]); return; }
            InningsIndex++; // a side with no players (solo practice) skips its innings
        }
        Complete();
    }

    void BeginBatter(string id)
    {
        CurrentBatter = id;
        ConsecutiveMisses = 0;
        AttemptNumber = 1;
        Stats[id].HasBatted = true;
    }

    void EnsureLive()
    {
        if (IsComplete) throw new InvalidOperationException("The match is complete.");
        if (CurrentBatter is null) throw new InvalidOperationException("No batter is at the crease.");
    }

    /// <summary>The swing missed, the gilli dropped, or the hit was a mishit.</summary>
    public AttemptResult RecordMiss(string reason)
    {
        EnsureLive();
        ConsecutiveMisses++;
        if (ConsecutiveMisses >= cfg.MaxConsecutiveMisses)
            return FinishBatter(AttemptOutcome.Out, OutKind.ThreeMisses, $"{cfg.MaxConsecutiveMisses} misses in a row", reason);
        return Continue(new AttemptResult
        {
            Outcome = AttemptOutcome.Miss, BatterId = CurrentBatter!, Team = BattingTeam, Reason = reason,
            MissesAfter = ConsecutiveMisses, AttemptNumber = AttemptNumber
        });
    }

    /// <summary>A fielder caught the gilli before it landed.</summary>
    public AttemptResult RecordCatch(string fielderName) => RecordOut(OutKind.Caught, $"Caught by {fielderName}");

    /// <summary>The fielder's throw hit the target (the danda across the pit).</summary>
    public AttemptResult RecordTargetHit(string fielderName) => RecordOut(OutKind.TargetHit, $"{fielderName}'s throw hit the danda");

    public AttemptResult RecordOut(OutKind kind, string reason)
    {
        EnsureLive();
        return FinishBatter(AttemptOutcome.Out, kind, reason, reason);
    }

    /// <summary>Points for a safe hit: floor(distance / danda length) + bonus.</summary>
    public (int distancePoints, int bonus, int total, float distance) ScoreFor(float distance)
    {
        // score from the distance rounded to centimetres: exactly what every client displays
        float d = MathF.Round(MathF.Max(0, distance), 2);
        int dp = (int)Math.Floor(d / (double)cfg.DandaLength + 1e-6);
        return (dp, cfg.SafeHitBonus, dp + cfg.SafeHitBonus, d);
    }

    /// <summary>The gilli was hit, not caught, and the throw missed the target.</summary>
    public AttemptResult RecordSafeHit(float distance, string reason = "Safe")
    {
        EnsureLive();
        var (dp, bonus, pts, d) = ScoreFor(distance);
        var batter = CurrentBatter!;
        var team = BattingTeam;
        Scores[(int)team] += pts;
        var st = Stats[batter];
        st.Points += pts; st.SafeHits++; st.Longest = MathF.Max(st.Longest, d);
        ConsecutiveMisses = 0;

        var result = new AttemptResult
        {
            Outcome = AttemptOutcome.Safe, BatterId = batter, Team = team, Reason = reason,
            Distance = d, DistancePoints = dp, Bonus = bonus, Points = pts, MissesAfter = 0, AttemptNumber = AttemptNumber
        };

        if (cfg.EndWhenChaseComplete && InningsIndex == TotalInnings - 1 && Scores[(int)team] > Scores[(int)FieldingTeam])
        {
            ChaseCompleted = true;
            Complete();
            return result with { InningsEnded = true, MatchEnded = true, BatterFinished = true };
        }
        return Continue(result);
    }

    /// <summary>Retire the current batter without it counting as a dismissal (e.g. left the match).</summary>
    public AttemptResult RetireBatter(string reason)
    {
        EnsureLive();
        return FinishBatter(AttemptOutcome.Out, OutKind.Retired, reason, reason);
    }

    AttemptResult Continue(AttemptResult r)
    {
        if (cfg.MaxAttemptsPerBatter > 0 && AttemptNumber >= cfg.MaxAttemptsPerBatter)
        {
            Stats[CurrentBatter!].Out = OutKind.AttemptLimit;
            return Advance(r with { BatterFinished = true, Reason = r.Reason + $" · {cfg.MaxAttemptsPerBatter} attempts used, batter retires" });
        }
        AttemptNumber++;
        return r;
    }

    AttemptResult FinishBatter(AttemptOutcome outcome, OutKind kind, string reason, string detail)
    {
        Stats[CurrentBatter!].Out = kind;
        var r = new AttemptResult
        {
            Outcome = outcome, OutKind = kind, BatterId = CurrentBatter!, Team = BattingTeam,
            Reason = reason == detail ? reason : $"{detail} · {reason}", MissesAfter = ConsecutiveMisses,
            AttemptNumber = AttemptNumber, BatterFinished = true
        };
        return Advance(r);
    }

    AttemptResult Advance(AttemptResult r)
    {
        int team = (int)BattingTeam;
        nextBatter[team]++;
        if (nextBatter[team] < lineup[team].Count)
        {
            BeginBatter(lineup[team][nextBatter[team]]);
            return r;
        }
        // innings over
        CurrentBatter = null;
        InningsIndex++;
        StartInnings();
        return r with { InningsEnded = true, MatchEnded = IsComplete };
    }

    void Complete()
    {
        IsComplete = true;
        CurrentBatter = null;
        Winner = Scores[0] > Scores[1] ? Team.A : Scores[1] > Scores[0] ? Team.B : null;
    }

    /// <summary>End the match early (e.g. a whole side disconnected). The forfeiting side loses.</summary>
    public void Forfeit(Team losing)
    {
        if (IsComplete) return;
        IsComplete = true;
        CurrentBatter = null;
        Winner = Other(losing);
    }
}
