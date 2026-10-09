using System.Numerics;

namespace Gilli.Core.Physics;

/// <summary>
/// Analytic danda motion for one swing. The batter's hands are a pivot beside the pit; the danda
/// rotates about an axis tilted back by <see cref="PhysicsConfig.SwingTilt"/>, so at the moment it
/// points at the pit it is moving forward and upward. Aim rotates the whole rig around the pit.
///
/// direction(phi) = R cos(phi) + T sin(phi), where R points from the hands to the pit and
/// T = F cos(tilt) + U sin(tilt) is the swing direction at contact.
/// </summary>
public readonly struct SwingRig
{
    public readonly Vector3 Pivot, Right, Forward, Tangent, Axis;
    public readonly float AngularSpeed, StartAngle, EndAngle, Inner, Outer, Aim;

    public SwingRig(PhysicsConfig c, Vector3 pit, float aim)
    {
        Aim = aim;
        Forward = AimForward(aim);
        Right = new Vector3(MathF.Cos(aim), 0, MathF.Sin(aim));
        Tangent = Forward * MathF.Cos(c.SwingTilt) + Vector3.UnitY * MathF.Sin(c.SwingTilt);
        Axis = Vector3.UnitY * MathF.Cos(c.SwingTilt) - Forward * MathF.Sin(c.SwingTilt); // Axis x Right = Tangent
        Pivot = pit - Right * c.PivotSideOffset + Vector3.UnitY * c.PivotHeight;
        AngularSpeed = c.SwingAngularSpeed;
        StartAngle = c.SwingStartAngle;
        EndAngle = c.SwingEndAngle;
        Inner = c.DandaInner;
        Outer = c.DandaOuter;
    }

    /// <summary>Field direction for an aim angle: aim 0 is straight down the field (-Z), positive aims towards +X.</summary>
    public static Vector3 AimForward(float aim) => new(MathF.Sin(aim), 0, -MathF.Cos(aim));

    public float Duration => (EndAngle - StartAngle) / AngularSpeed;
    public float AngleAt(float t) => Math.Clamp(StartAngle + AngularSpeed * t, StartAngle, EndAngle);
    public Vector3 DirectionAt(float phi) => Right * MathF.Cos(phi) + Tangent * MathF.Sin(phi);
    public float CenterDistance => (Inner + Outer) * 0.5f;
    public float CapsuleLength(float radius) => Outer - Inner - 2 * radius;

    /// <summary>Pose of the danda capsule (local +Y along the stick, pointing away from the hands).</summary>
    public (Vector3 position, Quaternion orientation) PoseAt(float phi)
    {
        var d = DirectionAt(phi);
        return (Pivot + d * CenterDistance, FromTo(Vector3.UnitY, d));
    }

    /// <summary>Velocity of a world point rigidly attached to the danda while it is swinging.</summary>
    public Vector3 PointVelocity(Vector3 worldPoint) => Vector3.Cross(Axis * AngularSpeed, worldPoint - Pivot);

    /// <summary>Where the batter stands (feet) and which way they face for this aim.</summary>
    public Vector3 BatterFeet => Pivot - Vector3.UnitY * Pivot.Y - Right * 0.35f;
    public float BatterYaw => MathF.Atan2(Right.X, Right.Z);

    public static Quaternion FromTo(Vector3 from, Vector3 to)
    {
        float d = Vector3.Dot(from, to);
        if (d > 0.99999f) return Quaternion.Identity;
        if (d < -0.99999f)
        {
            var ortho = MathF.Abs(from.X) < 0.9f ? Vector3.UnitX : Vector3.UnitZ;
            return Quaternion.CreateFromAxisAngle(Vector3.Normalize(Vector3.Cross(from, ortho)), MathF.PI);
        }
        var axis = Vector3.Cross(from, to);
        var q = new Quaternion(axis, 1 + d);
        return Quaternion.Normalize(q);
    }
}
