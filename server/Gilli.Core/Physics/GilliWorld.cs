using System.Numerics;
using System.Runtime.CompilerServices;
using BepuPhysics;
using BepuPhysics.Collidables;
using BepuPhysics.CollisionDetection;
using BepuPhysics.Constraints;
using BepuUtilities;
using BepuUtilities.Memory;

namespace Gilli.Core.Physics;

public enum ContactKind { None, Ground, Obstacle, Target, Danda }

/// <summary>Contacts captured by the narrow phase during one simulation step.</summary>
internal sealed class ContactLog
{
    public BodyHandle Gilli, Danda;
    public StaticHandle Ground;
    public StaticHandle? Target;

    // danda: deepest contact this step (no solver constraint is created; the impulse is ours)
    public bool DandaTouched;
    public Vector3 DandaPoint, DandaNormal; // normal from danda towards gilli
    public float DandaDepth = float.MinValue;

    public bool GroundTouched, ObstacleTouched, TargetTouched;
    public Vector3 GroundPoint;
    public float GroundDepth = float.MinValue;

    public void Clear()
    {
        DandaTouched = false; DandaDepth = float.MinValue;
        GroundTouched = ObstacleTouched = TargetTouched = false; GroundDepth = float.MinValue;
    }

    public ContactKind Classify(CollidableReference c)
    {
        if (c.Mobility == CollidableMobility.Static)
        {
            if (c.StaticHandle.Value == Ground.Value) return ContactKind.Ground;
            if (Target.HasValue && c.StaticHandle.Value == Target.Value.Value) return ContactKind.Target;
            return ContactKind.Obstacle;
        }
        if (c.Mobility == CollidableMobility.Kinematic && c.BodyHandle.Value == Danda.Value) return ContactKind.Danda;
        return ContactKind.None;
    }
}

internal struct NarrowPhaseCallbacks : INarrowPhaseCallbacks
{
    public ContactLog Log;
    public PhysicsConfig Config;
    public Simulation? Sim;

    public void Initialize(Simulation simulation) => Sim = simulation;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public bool AllowContactGeneration(int workerIndex, CollidableReference a, CollidableReference b, ref float speculativeMargin)
        => a.Mobility == CollidableMobility.Dynamic || b.Mobility == CollidableMobility.Dynamic;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public bool AllowContactGeneration(int workerIndex, CollidablePair pair, int childIndexA, int childIndexB) => true;

    public bool ConfigureContactManifold<TManifold>(int workerIndex, CollidablePair pair, ref TManifold manifold, out PairMaterialProperties pairMaterial)
        where TManifold : unmanaged, IContactManifold<TManifold>
    {
        bool gilliIsA = pair.A.Mobility == CollidableMobility.Dynamic;
        var other = gilliIsA ? pair.B : pair.A;
        var kind = Log.Classify(other);

        // find the deepest contact in the manifold
        int count = manifold.Count;
        float bestDepth = float.MinValue; Vector3 bestOffset = default, bestNormal = default;
        for (int i = 0; i < count; i++)
        {
            manifold.GetContact(i, out var offset, out var normal, out var depth, out _);
            if (depth > bestDepth) { bestDepth = depth; bestOffset = offset; bestNormal = normal; }
        }
        Vector3 posA = Sim!.Bodies[gilliIsA ? pair.A.BodyHandle : pair.B.BodyHandle].Pose.Position;
        if (!gilliIsA)
        {
            // A is the other collidable; offsets are relative to A
            posA = other.Mobility == CollidableMobility.Static
                ? Sim.Statics[other.StaticHandle].Pose.Position
                : Sim.Bodies[other.BodyHandle].Pose.Position;
        }
        // BEPU normals point from B to A: flip so the normal always points towards the gilli
        Vector3 towardsGilli = gilliIsA ? bestNormal : -bestNormal;
        Vector3 worldPoint = posA + bestOffset;

        if (kind == ContactKind.Danda)
        {
            pairMaterial = default;
            if (count > 0 && bestDepth > Log.DandaDepth)
            {
                Log.DandaTouched = true; Log.DandaDepth = bestDepth; Log.DandaPoint = worldPoint; Log.DandaNormal = towardsGilli;
            }
            return false; // the bat impulse is computed explicitly from the contact (see GilliWorld.ResolveDandaContact)
        }

        if (count > 0 && bestDepth > -0.004f)
        {
            switch (kind)
            {
                case ContactKind.Ground:
                    Log.GroundTouched = true;
                    if (bestDepth > Log.GroundDepth) { Log.GroundDepth = bestDepth; Log.GroundPoint = worldPoint; }
                    break;
                case ContactKind.Target: Log.TargetTouched = true; break;
                case ContactKind.Obstacle: Log.ObstacleTouched = true; break;
            }
        }
        pairMaterial = new PairMaterialProperties(kind == ContactKind.Ground ? Config.GroundFriction : 0.5f, 2f, new SpringSettings(30, 1));
        return true;
    }

    public bool ConfigureContactManifold(int workerIndex, CollidablePair pair, int childIndexA, int childIndexB, ref ConvexContactManifold manifold) => true;

    public void Dispose() { }
}

internal struct PoseIntegratorCallbacks : IPoseIntegratorCallbacks
{
    public Vector3 Gravity;
    public float AirDrag, AngularDamping;
    Vector3Wide gravityDt;
    Vector<float> dragDt, angularScale;

    public readonly AngularIntegrationMode AngularIntegrationMode => AngularIntegrationMode.Nonconserving;
    public readonly bool AllowSubstepsForUnconstrainedBodies => false;
    public readonly bool IntegrateVelocityForKinematics => false;

    public void Initialize(Simulation simulation) { }

    public void PrepareForIntegration(float dt)
    {
        gravityDt = Vector3Wide.Broadcast(Gravity * dt);
        dragDt = new Vector<float>(AirDrag * dt);
        angularScale = new Vector<float>(MathF.Pow(Math.Clamp(1 - AngularDamping, 0, 1), dt));
    }

    public void IntegrateVelocity(Vector<int> bodyIndices, Vector3Wide position, QuaternionWide orientation, BodyInertiaWide localInertia,
        Vector<int> integrationMask, int workerIndex, Vector<float> dt, ref BodyVelocityWide velocity)
    {
        // gravity and quadratic air drag: v += g dt - k |v| v dt
        Vector3Wide.Length(velocity.Linear, out var speed);
        var dragScale = Vector<float>.One - Vector.Min(speed * dragDt, new Vector<float>(0.5f));
        velocity.Linear = (velocity.Linear + gravityDt) * dragScale;
        velocity.Angular *= angularScale;
    }
}

/// <summary>Snapshot of the gilli rigid body.</summary>
public readonly record struct BodyState(Vector3 Position, Quaternion Orientation, Vector3 Velocity, Vector3 AngularVelocity);

/// <summary>What happened during a call to <see cref="GilliWorld.Step"/>.</summary>
public struct StepReport
{
    public bool DandaHit;
    public Vector3 HitPoint, HitImpulse;
    public float HitSpeed;
    public bool GroundContact, GroundImpact, ObstacleContact, TargetContact;
    public Vector3 GroundPoint;
    public float ImpactSpeed;
}

/// <summary>
/// The authoritative physics world for one room, built on BEPUphysics v2.
/// BEPU integrates the gilli rigid body (gravity, drag, rotation), detects all contacts
/// (danda, ground, solid objects, target danda) and solves resting / friction contacts.
/// Two things are layered on top because BEPU v2 has no restitution coefficient:
///  * the danda-gilli impact impulse (with restitution and friction) is computed from the BEPU contact;
///  * ground bounces restore a fraction of the incoming normal speed.
/// </summary>
public sealed class GilliWorld : IDisposable
{
    readonly BufferPool pool = new();
    readonly Simulation sim;
    readonly ContactLog log = new();
    readonly PhysicsConfig cfg;
    readonly BodyHandle gilli, danda;
    readonly TypedIndex targetShape;
    StaticHandle? target;

    SwingRig rig;
    bool swinging;
    float swingTime;
    bool swingHitDone;
    float restTimer;

    public float Time { get; private set; }
    public PhysicsConfig Config => cfg;
    public Vector3 Pit { get; } = Vector3.Zero;
    public SwingRig Rig => rig;
    public bool Swinging => swinging;
    public float SwingTime => swingTime;
    public bool SwingConnected => swingHitDone;
    public bool TargetPresent => target.HasValue;
    /// <summary>True while the gilli has been nearly motionless for <see cref="PhysicsConfig.RestHoldTime"/>.</summary>
    public bool AtRest => restTimer >= cfg.RestHoldTime;
    public bool InGroundContact { get; private set; }

    public GilliWorld(PhysicsConfig config, FieldLayout layout)
    {
        cfg = config;
        var narrow = new NarrowPhaseCallbacks { Log = log, Config = cfg };
        var integ = new PoseIntegratorCallbacks { Gravity = new Vector3(0, -cfg.Gravity, 0), AirDrag = cfg.AirDrag, AngularDamping = cfg.AngularDamping };
        sim = Simulation.Create(pool, narrow, integ, new SolveDescription(8, 1));

        // ground: one big thick slab so nothing can tunnel through it
        log.Ground = sim.Statics.Add(new StaticDescription(new Vector3(0, -1f, 0), Quaternion.Identity, sim.Shapes.Add(new Box(600, 2, 600))));

        foreach (var o in layout.Obstacles) AddObstacle(o);

        var gilliShape = new Capsule(cfg.GilliRadius, cfg.GilliLength);
        var gilliInertia = gilliShape.ComputeInertia(cfg.GilliMass);
        gilli = sim.Bodies.Add(BodyDescription.CreateDynamic(
            new RigidPose(RestPosition, RestOrientation), gilliInertia,
            new CollidableDescription(sim.Shapes.Add(gilliShape), 0.2f, ContinuousDetection.Continuous(1e-4f, 1e-4f)),
            new BodyActivityDescription(-1f))); // never sleep: the simulation is tiny
        log.Gilli = gilli;

        rig = new SwingRig(cfg, Pit, 0);
        var dandaShape = new Capsule(cfg.DandaRadius, rig.CapsuleLength(cfg.DandaRadius));
        var (dp, dq) = rig.PoseAt(rig.StartAngle);
        danda = sim.Bodies.Add(BodyDescription.CreateKinematic(new RigidPose(dp, dq), new CollidableDescription(sim.Shapes.Add(dandaShape), 0.3f), new BodyActivityDescription(-1f)));
        log.Danda = danda;

        // the danda laid across the pit as the fielder's target (only present while a throw is in play)
        targetShape = sim.Shapes.Add(new Box(rig.Outer - rig.Inner, cfg.DandaRadius * 2, cfg.DandaRadius * 2));
    }

    void AddObstacle(Obstacle o)
    {
        var rot = Quaternion.CreateFromAxisAngle(Vector3.UnitY, o.RotY);
        switch (o.Kind)
        {
            case ObstacleKind.Palm or ObstacleKind.Neem:
                sim.Statics.Add(new StaticDescription(new Vector3(o.X, o.Height / 2, o.Z), rot, sim.Shapes.Add(new Cylinder(o.Radius * o.Scale + 0.05f, o.Height))));
                break;
            case ObstacleKind.Banyan:
                sim.Statics.Add(new StaticDescription(new Vector3(o.X, 3, o.Z), rot, sim.Shapes.Add(new Cylinder(o.Radius * o.Scale, 6))));
                sim.Statics.Add(new StaticDescription(new Vector3(o.X, 0.35f, o.Z), rot, sim.Shapes.Add(new Cylinder(3.3f * o.Scale, 0.7f))));
                break;
            case ObstacleKind.WaterTank:
                sim.Statics.Add(new StaticDescription(new Vector3(o.X, 7, o.Z), rot, sim.Shapes.Add(new Box(4, 14, 4))));
                break;
            default:
                sim.Statics.Add(new StaticDescription(new Vector3(o.X, o.Height / 2, o.Z), rot, sim.Shapes.Add(new Box(o.Width, o.Height, o.Depth))));
                break;
        }
    }

    public Vector3 RestPosition => Pit + new Vector3(0, cfg.GilliRadius, 0);
    /// <summary>Gilli lies across the pit along X (capsule local Y rotated onto X).</summary>
    public static Quaternion RestOrientation => Quaternion.CreateFromAxisAngle(Vector3.UnitZ, -MathF.PI / 2);

    public BodyState Gilli
    {
        get
        {
            var b = sim.Bodies[gilli];
            return new BodyState(b.Pose.Position, b.Pose.Orientation, b.Velocity.Linear, b.Velocity.Angular);
        }
    }

    public (Vector3 position, Quaternion orientation) DandaPose
    {
        get { var b = sim.Bodies[danda]; return (b.Pose.Position, b.Pose.Orientation); }
    }

    public void PlaceGilli(Vector3 position, Quaternion orientation, Vector3 velocity, Vector3 angular)
    {
        var b = sim.Bodies[gilli];
        b.Pose.Position = position;
        b.Pose.Orientation = Quaternion.Normalize(orientation);
        b.Velocity.Linear = velocity;
        b.Velocity.Angular = angular;
        b.Awake = true;
        sim.Bodies.UpdateBounds(gilli);
        restTimer = 0;
    }

    /// <summary>Puts the gilli back across the pit and the danda in the batter's hands for this aim.</summary>
    public void ResetForAttempt(float aim)
    {
        PlaceGilli(RestPosition, RestOrientation, Vector3.Zero, Vector3.Zero);
        SetAim(aim);
        swinging = false; swingHitDone = false; swingTime = 0;
        SetTarget(false);
    }

    public void SetAim(float aim)
    {
        rig = new SwingRig(cfg, Pit, Math.Clamp(aim, -cfg.MaxAimAngle, cfg.MaxAimAngle));
        if (!swinging) PoseDanda(rig.StartAngle, false);
    }

    void PoseDanda(float phi, bool moving)
    {
        var b = sim.Bodies[danda];
        var (p, q) = rig.PoseAt(phi);
        b.Pose.Position = p; b.Pose.Orientation = q;
        if (moving)
        {
            b.Velocity.Angular = rig.Axis * rig.AngularSpeed;
            b.Velocity.Linear = rig.PointVelocity(p);
        }
        else { b.Velocity.Linear = Vector3.Zero; b.Velocity.Angular = Vector3.Zero; }
        b.Awake = true;
        sim.Bodies.UpdateBounds(danda);
    }

    /// <summary>
    /// Flick: the danda taps the tapered end of the gilli. The bevel turns the downward tap into
    /// an upward pop; this is applied as an impulse slightly off-centre, which also spins the gilli.
    /// </summary>
    public void Flick()
    {
        var b = sim.Bodies[gilli];
        var axis = Vector3.Transform(Vector3.UnitY, b.Pose.Orientation);
        var impulse = cfg.GilliMass * (Vector3.UnitY * cfg.FlickSpeed + rig.Forward * cfg.FlickForwardSpeed);
        var offset = axis * cfg.FlickOffset;
        b.Awake = true;
        b.ApplyImpulse(impulse, offset);
        restTimer = 0;
    }

    public void StartSwing()
    {
        swinging = true; swingTime = 0; swingHitDone = false;
        PoseDanda(rig.StartAngle, true);
    }

    public void SetTarget(bool present)
    {
        if (present && !target.HasValue)
        {
            target = sim.Statics.Add(new StaticDescription(Pit + new Vector3(0, cfg.DandaRadius, 0), Quaternion.Identity, targetShape));
            log.Target = target;
        }
        else if (!present && target.HasValue)
        {
            sim.Statics.Remove(target.Value);
            target = null; log.Target = null;
        }
    }

    /// <summary>Advances the simulation by one fixed step (substepped while the danda is swinging).</summary>
    public StepReport Step()
    {
        var report = new StepReport();
        int sub = swinging ? cfg.SwingSubsteps : 1;
        float dt = cfg.FixedStep / sub;
        for (int i = 0; i < sub; i++)
        {
            if (swinging) PoseDanda(rig.AngleAt(swingTime), true);
            var pre = sim.Bodies[gilli].Velocity.Linear;
            log.Clear();
            sim.Timestep(dt);
            Time += dt;

            if (swinging)
            {
                if (!swingHitDone && log.DandaTouched) ResolveDandaContact(dt, ref report);
                swingTime += dt;
                if (swingTime >= rig.Duration) { swinging = false; PoseDanda(rig.EndAngle, false); }
            }

            InGroundContact = log.GroundTouched;
            if (log.GroundTouched)
            {
                report.GroundContact = true;
                report.GroundPoint = log.GroundPoint;
                if (-pre.Y > cfg.BounceThreshold)
                {
                    report.GroundImpact = true;
                    report.ImpactSpeed = MathF.Max(report.ImpactSpeed, -pre.Y);
                    // BEPU contacts are inelastic: give back a fraction of the incoming normal speed
                    var b = sim.Bodies[gilli];
                    var v = b.Velocity.Linear;
                    if (v.Y < -pre.Y * cfg.GroundRestitution) b.Velocity.Linear = new Vector3(v.X, -pre.Y * cfg.GroundRestitution, v.Z);
                }
                else
                {
                    // rolling / sliding on rough earth
                    var b = sim.Bodies[gilli];
                    float k = MathF.Exp(-cfg.RollingDrag * dt);
                    var v = b.Velocity.Linear;
                    b.Velocity.Linear = new Vector3(v.X * k, v.Y, v.Z * k);
                    b.Velocity.Angular *= MathF.Exp(-3f * dt);
                }
            }
            if (log.ObstacleTouched) report.ObstacleContact = true;
            if (log.TargetTouched) report.TargetContact = true;

            var s = Gilli;
            if (s.Velocity.Length() < cfg.RestLinearSpeed && s.AngularVelocity.Length() < cfg.RestAngularSpeed && InGroundContact)
                restTimer += dt;
            else if (s.Velocity.Length() > cfg.RestLinearSpeed * 2)
                restTimer = 0;
        }
        return report;
    }

    /// <summary>
    /// Danda-gilli impact. BEPU reported a (possibly speculative) contact between the swinging
    /// kinematic danda and the gilli. If the two will actually touch within this substep and the
    /// danda is moving into the gilli, apply the rigid-body impulse
    ///   j = -(1 + e) v_n / (1/m + n . ((I^-1 (r x n)) x r))
    /// at the contact point (so the hit also produces torque), plus Coulomb friction.
    /// </summary>
    void ResolveDandaContact(float dt, ref StepReport report)
    {
        var b = sim.Bodies[gilli];
        var pose = b.Pose;
        var n = Vector3.Normalize(log.DandaNormal);
        var p = log.DandaPoint;
        // safety: normal must point from the danda towards the gilli
        if (Vector3.Dot(n, pose.Position - p) < 0) n = -n;

        var r = p - pose.Position;
        var vGilli = b.Velocity.Linear + Vector3.Cross(b.Velocity.Angular, r);
        var vDanda = rig.PointVelocity(p);
        var rel = vDanda - vGilli;
        float approach = Vector3.Dot(rel, n);
        if (approach <= 0) return;
        if (log.DandaDepth + approach * dt < -0.002f) return; // speculative contact that will not close this substep

        var invInertia = b.LocalInertia.InverseInertiaTensor;
        float invMass = b.LocalInertia.InverseMass;
        Vector3 ApplyInvInertia(Vector3 v)
        {
            var local = Vector3.Transform(v, Quaternion.Conjugate(pose.Orientation));
            var l = new Vector3(
                invInertia.XX * local.X + invInertia.YX * local.Y + invInertia.ZX * local.Z,
                invInertia.YX * local.X + invInertia.YY * local.Y + invInertia.ZY * local.Z,
                invInertia.ZX * local.X + invInertia.ZY * local.Y + invInertia.ZZ * local.Z);
            return Vector3.Transform(l, pose.Orientation);
        }
        float Effective(Vector3 dir) => invMass + Vector3.Dot(dir, Vector3.Cross(ApplyInvInertia(Vector3.Cross(r, dir)), r));

        float jn = (1 + cfg.DandaRestitution) * approach / Effective(n);
        var impulse = n * jn;
        var tangential = rel - n * approach;
        float tl = tangential.Length();
        if (tl > 1e-4f)
        {
            var t = tangential / tl;
            float jt = MathF.Min(cfg.DandaFriction * jn, tl / Effective(t));
            impulse += t * jt;
        }
        b.ApplyImpulse(impulse, r);
        b.Awake = true;
        swingHitDone = true;
        restTimer = 0;
        report.DandaHit = true;
        report.HitPoint = p;
        report.HitImpulse = impulse;
        report.HitSpeed = b.Velocity.Linear.Length();
    }

    /// <summary>Launches a fielder's throw from a release point.</summary>
    public void Throw(Vector3 release, float yaw, float pitch, float power)
    {
        power = Math.Clamp(power, 0, 1);
        pitch = Math.Clamp(pitch, cfg.ThrowMinPitch, cfg.ThrowMaxPitch);
        float speed = cfg.ThrowMinSpeed + (cfg.ThrowMaxSpeed - cfg.ThrowMinSpeed) * power;
        var dir = new Vector3(MathF.Sin(yaw) * MathF.Cos(pitch), MathF.Sin(pitch), MathF.Cos(yaw) * MathF.Cos(pitch));
        var axis = Vector3.Normalize(Vector3.Cross(dir, Vector3.UnitY) + new Vector3(0, 0.001f, 0));
        PlaceGilli(release, SwingRig.FromTo(Vector3.UnitY, dir), dir * speed, axis * 18f); // tumbles end over end
    }

    public void Dispose()
    {
        sim.Dispose();
        pool.Clear();
    }
}
