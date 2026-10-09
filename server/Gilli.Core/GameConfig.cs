namespace Gilli.Core;

/// <summary>
/// The selected rule set for this game. These are configurable project rules, not a claim
/// that every region of Tamil Nadu plays Gilli-Danda / Kitti Pull the same way.
/// </summary>
public sealed record RulesConfig
{
    /// <summary>Scoring unit: one danda length in metres. distance points = floor(distance / DandaLength).</summary>
    public float DandaLength { get; init; } = 0.75f;
    /// <summary>Bonus added to every safe hit.</summary>
    public int SafeHitBonus { get; init; } = 1;
    /// <summary>Consecutive failed attempts that make the batter out.</summary>
    public int MaxConsecutiveMisses { get; init; } = 3;
    /// <summary>Attempts after which a batter retires (not out) so an innings cannot run forever. 0 = unlimited.</summary>
    public int MaxAttemptsPerBatter { get; init; } = 8;
    public int InningsPerTeam { get; init; } = 1;
    /// <summary>End the match as soon as the side batting last passes the other side's total.</summary>
    public bool EndWhenChaseComplete { get; init; } = true;
    /// <summary>A hit whose gilli comes to rest closer than this to the pit (or behind the batting line) is a mishit and counts as a miss.</summary>
    public float MinScoringDistance { get; init; } = 2.0f;

    /// <summary>Horizontal reach of a fielder attempting a catch.</summary>
    public float CatchRadius { get; init; } = 1.6f;
    public float CatchMinHeight { get; init; } = 0.15f;
    public float CatchMaxHeight { get; init; } = 2.7f;
    /// <summary>A catch press stays live for this long so a slightly early press still counts.</summary>
    public float CatchAttemptWindow { get; init; } = 0.35f;
    /// <summary>Minimum time between two catch presses by the same fielder.</summary>
    public float CatchCooldown { get; init; } = 0.6f;

    /// <summary>The thrown gilli counts as hitting the target if it touches the danda laid across the pit,
    /// or first touches the ground within this radius of the pit.</summary>
    public float TargetRadius { get; init; } = 1.0f;

    public float FlickTimeLimit { get; init; } = 25f;
    public float ThrowTimeLimit { get; init; } = 15f;
    public float TossChoiceTimeLimit { get; init; } = 15f;
    public float ResultDisplayTime { get; init; } = 3.2f;
    public float DisconnectGrace { get; init; } = 20f;
}

/// <summary>Physical constants of the authoritative simulation (SI units).</summary>
public sealed record PhysicsConfig
{
    public float Gravity { get; init; } = 9.81f;
    public float FixedStep { get; init; } = 1f / 120f;
    /// <summary>Substeps per fixed step while the danda is swinging (danda tip moves ~1.5 cm per substep).</summary>
    public int SwingSubsteps { get; init; } = 8;

    // gilli: wooden capsule, ~18 cm long, 4.4 cm thick
    public float GilliRadius { get; init; } = 0.022f;
    public float GilliLength { get; init; } = 0.136f; // cylindrical part; total = length + 2 * radius
    public float GilliMass { get; init; } = 0.06f;
    /// <summary>Quadratic air drag coefficient k in a = -k|v|v (tuned for gameplay).</summary>
    public float AirDrag { get; init; } = 0.012f;
    public float AngularDamping { get; init; } = 0.15f;

    // danda: 0.74 m stick held at one end
    public float DandaRadius { get; init; } = 0.025f;
    public float DandaInner { get; init; } = 0.06f;  // from hands pivot to near end
    public float DandaOuter { get; init; } = 0.80f;  // from hands pivot to far tip

    // batting rig
    public float PivotHeight { get; init; } = 0.95f;
    public float PivotSideOffset { get; init; } = 0.50f;   // hands sit this far to the side of the pit
    public float SwingTilt { get; init; } = 0.4363f;       // 25 degrees of upward swing path
    public float SwingAngularSpeed { get; init; } = 32f;   // rad/s
    public float SwingStartAngle { get; init; } = -2.2689f; // -130 degrees
    public float SwingEndAngle { get; init; } = 1.9199f;   // +110 degrees
    public float MaxAimAngle { get; init; } = 0.75f;       // radians either side of straight

    /// <summary>Upward pop speed of the flick (apex ~1 m).</summary>
    public float FlickSpeed { get; init; } = 4.40f;
    public float FlickForwardSpeed { get; init; } = 0.05f;
    /// <summary>Impulse applied this far from the gilli centre along its axis (gives the flick spin).</summary>
    public float FlickOffset { get; init; } = 0.008f;

    public float DandaRestitution { get; init; } = 0.5f;
    public float DandaFriction { get; init; } = 0.3f;
    public float GroundRestitution { get; init; } = 0.3f;
    public float GroundFriction { get; init; } = 0.65f;
    public float BounceThreshold { get; init; } = 1.2f;
    public float RollingDrag { get; init; } = 3.2f;

    public float RestLinearSpeed { get; init; } = 0.15f;
    public float RestAngularSpeed { get; init; } = 2.0f;
    public float RestHoldTime { get; init; } = 0.3f;
    public float MaxFlightTime { get; init; } = 9f;

    // throw
    public float ThrowMinSpeed { get; init; } = 6f;
    public float ThrowMaxSpeed { get; init; } = 30f;
    public float ThrowMinPitch { get; init; } = 0.05f;
    public float ThrowMaxPitch { get; init; } = 1.2f;
    public float ThrowReleaseHeight { get; init; } = 1.5f;

    // players
    public float MaxRunSpeed { get; init; } = 7.5f;
    public float PlayerRadius { get; init; } = 0.4f;
}

public sealed record GameConfig
{
    public RulesConfig Rules { get; init; } = new();
    public PhysicsConfig Physics { get; init; } = new();
    public int MaxPlayers { get; init; } = 4;
    public static GameConfig Default { get; } = new();
}
