using System.Numerics;
using Gilli.Core.Rules;

namespace Gilli.Core.Rooms;

/// <summary>
/// CPU players for the single-player (vs computer) mode. Bots are ordinary seats driven by the server:
/// they call the same validated actions as a browser (Aim, Flick, Swing, Catch, Throw) and move at a
/// capped speed, so the physics and rules treat them exactly like people. Skill only changes their
/// timing error, reaction time, running speed, catch reliability and throwing accuracy.
/// </summary>
public sealed partial class Room
{
    public sealed record BotSkill(float SwingSigma, float RunSpeed, float Reaction, float CatchChance, float ThrowYawSigma, float ThrowPowerSigma);

    public static BotSkill SkillFor(Difficulty d) => d switch
    {
        Difficulty.Easy => new BotSkill(SwingSigma: 0.075f, RunSpeed: 5.2f, Reaction: 0.55f, CatchChance: 0.5f, ThrowYawSigma: 0.07f, ThrowPowerSigma: 0.07f),
        Difficulty.Hard => new BotSkill(SwingSigma: 0.025f, RunSpeed: 7.2f, Reaction: 0.2f, CatchChance: 0.9f, ThrowYawSigma: 0.02f, ThrowPowerSigma: 0.025f),
        _ => new BotSkill(SwingSigma: 0.045f, RunSpeed: 6.3f, Reaction: 0.35f, CatchChance: 0.72f, ThrowYawSigma: 0.04f, ThrowPowerSigma: 0.045f),
    };

    static readonly string[] BotNames = { "Murugan", "Selvi", "Karthik", "Lakshmi", "Arjun", "Divya" };

    // per-attempt bot plan
    int botPlanAttempt = -1;
    double botActAt, botThrowAt;
    float botAim, botSwingDelay;
    bool botAimSent, botWillCatch;
    string? chaserId;
    Vector2 chaseTarget;
    double chaseRetargetAt;

    void AddBots()
    {
        int a = TeamSize - 1, b = TeamSize, n = 0;
        for (int i = 0; i < a + b; i++)
        {
            var team = i < a ? Team.A : Team.B;
            var bot = new Player
            {
                Id = "cpu-" + NewId(4),
                Name = BotNames[n++ % BotNames.Length] + " (CPU)",
                Token = NewId(16),
                JoinOrder = joinCounter++,
                Team = team,
                Ready = true,
                IsBot = true,
            };
            bot.Pos = Layout.WaitingSpots[players.Count % Layout.WaitingSpots.Count];
            players.Add(bot);
        }
        Emit("info", $"{TeamSize} v {TeamSize} against the computer ({Difficulty})");
    }

    BotSkill Skill => SkillFor(Difficulty);

    float Gaussian() => (float)(Math.Sqrt(-2 * Math.Log(1 - rng.NextDouble())) * Math.Cos(2 * Math.PI * rng.NextDouble()));

    void NewBotPlan()
    {
        botPlanAttempt = attempt.Id;
        botActAt = Now + 1.0 + rng.NextDouble() * 0.9;
        botAim = (float)(rng.NextDouble() * 2 - 1) * 0.45f;
        botAimSent = false;
        // two good moments to strike: on the way up (~0.29 s) or on the way down (~0.46 s), plus human-like error
        botSwingDelay = (rng.NextDouble() < 0.6 ? 0.29f : 0.46f) + Gaussian() * Skill.SwingSigma;
        botWillCatch = rng.NextDouble() < Skill.CatchChance;
        botThrowAt = -1;
        chaserId = null;
        chaseRetargetAt = 0;
    }

    void UpdateBots(double dtD)
    {
        if (rules is null || world is null || rules.IsComplete) return;
        float dt = (float)dtD;
        if (botPlanAttempt != attempt.Id) NewBotPlan();
        if (Find(rules.CurrentBatter ?? "") is { IsBot: true } batter) BotBat(batter);
        var fielders = players.Where(p => !p.Left && p.Team == rules.FieldingTeam).OrderBy(p => p.JoinOrder).ToList();
        for (int i = 0; i < fielders.Count; i++)
            if (fielders[i].IsBot) BotField(fielders[i], fielders, Layout.FieldingSpots[i % Layout.FieldingSpots.Count], dt);
    }

    void BotBat(Player bot)
    {
        if (attempt.Resolved) return;
        if (attempt.Phase == AttemptPhase.Ready)
        {
            if (!botAimSent && Now >= botActAt - 0.6) { Aim(bot.Id, botAim); botAimSent = true; }
            if (Now >= botActAt) Flick(bot.Id, attempt.Id);
        }
        else if (attempt.Phase == AttemptPhase.Popped && !attempt.Swung && Now - attempt.PhaseStart >= botSwingDelay)
            Swing(bot.Id, attempt.Id);
    }

    void BotField(Player bot, List<Player> fielders, Vector2 home, float dt)
    {
        var g = world!.Gilli;
        switch (attempt.Phase)
        {
            case AttemptPhase.InFlight when !attempt.Landed:
                if (Now - attempt.PhaseStart < Skill.Reaction) return;
                if (chaserId is null || Now >= chaseRetargetAt)
                {
                    chaseTarget = PredictCatchPoint(g.Position, g.Velocity);
                    chaseRetargetAt = Now + 0.25;
                    chaserId ??= fielders.Where(f => f.IsBot).OrderBy(f => Vector2.Distance(f.Pos, chaseTarget)).First().Id;
                }
                if (bot.Id == chaserId)
                {
                    MoveBot(bot, chaseTarget, Skill.RunSpeed, dt);
                    float reach = Vector2.Distance(bot.Pos, new Vector2(g.Position.X, g.Position.Z));
                    if (botWillCatch && reach <= R.CatchRadius * 0.85f && g.Position.Y is > 0.4f and < 2.3f && Now - bot.CatchPressedAt >= R.CatchCooldown)
                        Catch(bot.Id, attempt.Id);
                }
                else MoveBot(bot, Vector2.Lerp(home, chaseTarget, 0.25f), Skill.RunSpeed * 0.5f, dt);
                break;

            case AttemptPhase.InFlight: // landed: the chaser runs to pick it up
                if (bot.Id == (chaserId ?? bot.Id)) MoveBot(bot, new Vector2(g.Position.X, g.Position.Z), Skill.RunSpeed, dt);
                break;

            case AttemptPhase.AwaitThrow when attempt.ThrowerId == bot.Id:
                if (botThrowAt < 0) botThrowAt = Now + 0.8 + rng.NextDouble() * 0.6;
                if (Now >= botThrowAt && !attempt.Thrown) BotThrow(bot);
                break;

            case AttemptPhase.Ready or AttemptPhase.Popped or AttemptPhase.Result:
                if (Vector2.Distance(bot.Pos, home) > 0.6f) MoveBot(bot, home, 3.0f, dt);
                else bot.Yaw = MathF.Atan2(-bot.Pos.X, -bot.Pos.Y);
                break;
        }
    }

    void MoveBot(Player bot, Vector2 target, float speed, float dt)
    {
        var d = target - bot.Pos;
        float len = d.Length();
        if (len < 0.05f) return;
        var step = d / len * MathF.Min(len, MathF.Min(speed, P.MaxRunSpeed) * dt);
        bot.Pos = Layout.ConstrainPlayer(bot.Pos + step, P.PlayerRadius);
        bot.Yaw = MathF.Atan2(step.X, step.Y);
    }

    /// <summary>Where the gilli will come down to catching height, integrated exactly like the server's pose callbacks.</summary>
    Vector2 PredictCatchPoint(Vector3 p, Vector3 v)
    {
        const float dt = 1f / 60;
        for (int i = 0; i < 360; i++)
        {
            StepBallistic(ref p, ref v, dt);
            if ((v.Y < 0 && p.Y <= 1.2f) || p.Y <= P.GilliRadius) break;
        }
        return new Vector2(p.X, p.Z);
    }

    void StepBallistic(ref Vector3 p, ref Vector3 v, float dt)
    {
        float scale = 1 - MathF.Min(v.Length() * P.AirDrag * dt, 0.5f);
        v = (v + new Vector3(0, -P.Gravity, 0) * dt) * scale;
        p += v * dt;
    }

    void BotThrow(Player bot)
    {
        var release = attempt.RestPoint with { Y = P.ThrowReleaseHeight };
        float yaw = MathF.Atan2(-release.X, -release.Z);
        float pitch = attempt.RestDistance < 12 ? 0.45f : 0.6f;
        // choose the power whose flight lands on the pit, then miss by a skill-dependent amount
        float best = 0.5f, bestErr = float.MaxValue;
        for (float power = 0; power <= 1.0001f; power += 0.01f)
        {
            float speed = P.ThrowMinSpeed + (P.ThrowMaxSpeed - P.ThrowMinSpeed) * power;
            var v = new Vector3(MathF.Sin(yaw) * MathF.Cos(pitch), MathF.Sin(pitch), MathF.Cos(yaw) * MathF.Cos(pitch)) * speed;
            var p = release;
            for (int i = 0; i < 600 && p.Y > P.GilliRadius; i++) StepBallistic(ref p, ref v, 1f / 120);
            float err = new Vector2(p.X, p.Z).Length();
            if (err < bestErr) { bestErr = err; best = power; }
        }
        yaw += Gaussian() * Skill.ThrowYawSigma;
        best = Math.Clamp(best + Gaussian() * Skill.ThrowPowerSigma, 0, 1);
        Throw(bot.Id, attempt.Id, yaw, pitch, best);
    }
}
