using System.Numerics;
using Gilli.Core;
using Gilli.Core.Physics;
using Xunit.Abstractions;

namespace Gilli.Tests;

public class PhysicsTests(ITestOutputHelper output)
{
    static readonly PhysicsConfig Cfg = new();

    public sealed record ShotResult(bool Hit, int HitCount, float HitSpeed, Vector3? Landing, Vector3 Rest, float MaxHeight, bool GroundBeforeHit, int GroundImpacts);

    /// <summary>Flick, wait <paramref name="swingDelay"/> seconds, swing, then run until the gilli rests.</summary>
    public static ShotResult Shot(GilliWorld w, float swingDelay, float aim = 0, bool swing = true)
    {
        w.ResetForAttempt(aim);
        for (int i = 0; i < 30; i++) w.Step(); // settle
        w.Flick();
        float t = 0; bool swung = false, hit = false, groundBeforeHit = false;
        int hits = 0, impacts = 0; float hitSpeed = 0, maxH = 0; Vector3? landing = null;
        while (t < 12)
        {
            if (swing && !swung && t >= swingDelay) { w.StartSwing(); swung = true; }
            var r = w.Step();
            t += Cfg.FixedStep;
            var g = w.Gilli;
            maxH = MathF.Max(maxH, g.Position.Y);
            if (r.DandaHit) { hit = true; hits++; hitSpeed = r.HitSpeed; }
            if (r.GroundImpact) impacts++;
            if (r.GroundContact && t > 0.2f)
            {
                if (!hit) groundBeforeHit = true;
                else if (landing == null) landing = r.GroundPoint;
            }
            if (!hit && groundBeforeHit && t > 1.5f) break;
            if (hit && w.AtRest && t > 0.5f) break;
        }
        return new ShotResult(hit, hits, hitSpeed, landing, w.Gilli.Position, maxH, groundBeforeHit, impacts);
    }

    [Fact]
    public void Gilli_rests_on_the_ground_without_sinking_or_drifting()
    {
        using var w = new GilliWorld(Cfg, FieldLayout.Default);
        w.ResetForAttempt(0);
        for (int i = 0; i < 240; i++) w.Step();
        var g = w.Gilli;
        Assert.InRange(g.Position.Y, Cfg.GilliRadius - 0.006f, Cfg.GilliRadius + 0.006f);
        Assert.True(new Vector2(g.Position.X, g.Position.Z).Length() < 0.01f);
        Assert.True(w.AtRest);
    }

    [Fact]
    public void Flick_pops_the_gilli_to_about_a_metre_and_it_falls_back_without_clipping()
    {
        using var w = new GilliWorld(Cfg, FieldLayout.Default);
        var r = Shot(w, 0, swing: false);
        output.WriteLine($"apex {r.MaxHeight:F3} rest {r.Rest}");
        Assert.False(r.Hit);
        Assert.InRange(r.MaxHeight, 0.9f, 1.1f);
        Assert.True(r.GroundBeforeHit);
        Assert.True(r.Rest.Y > 0.0f, "gilli fell through the ground");
    }

    [Fact]
    public void Swing_timing_sweep_produces_hits_and_misses()
    {
        using var w = new GilliWorld(Cfg, FieldLayout.Default);
        int hits = 0, misses = 0;
        for (float d = 0.0f; d <= 0.9f; d += 0.02f)
        {
            var r = Shot(w, d);
            float dist = new Vector2(r.Rest.X, r.Rest.Z).Length();
            output.WriteLine($"delay {d:F2} hit={r.Hit} n={r.HitCount} v={r.HitSpeed:F1} land={(r.Landing is { } l ? new Vector2(l.X, l.Z).Length().ToString("F1") : "-")} rest=({r.Rest.X:F1},{r.Rest.Z:F1}) dist={dist:F1} impacts={r.GroundImpacts}");
            if (r.Hit) hits++; else misses++;
            Assert.True(r.HitCount <= 1, "a swing must hit at most once");
        }
        Assert.True(hits > 0, "no timing produced a hit");
        Assert.True(misses > 0, "every timing hit: the swing is not timing-dependent");
    }

    [Fact]
    public void Swinging_before_the_flick_reaches_the_gilli_never_hits()
    {
        using var w = new GilliWorld(Cfg, FieldLayout.Default);
        w.ResetForAttempt(0);
        for (int i = 0; i < 30; i++) w.Step();
        w.StartSwing();
        bool hit = false;
        for (int i = 0; i < 60; i++) hit |= w.Step().DandaHit;
        Assert.False(hit);
        Assert.True(w.Gilli.Position.Y < 0.05f);
    }
}
