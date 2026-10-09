namespace Gilli.Core.Rooms;

/// <summary>Result of a client request. Code is machine-readable; Error is shown to the player.</summary>
public sealed record OpResult(bool Ok, string? Code = null, string? Error = null, object? Data = null)
{
    public static OpResult Success(object? data = null) => new(true, Data: data);
    public static OpResult Fail(string code, string error) => new(false, code, error);
}

public static class ErrorCodes
{
    public const string NotFound = "ROOM_NOT_FOUND";
    public const string Full = "ROOM_FULL";
    public const string InProgress = "MATCH_IN_PROGRESS";
    public const string InvalidName = "INVALID_NAME";
    public const string InvalidCode = "INVALID_CODE";
    public const string NotHost = "NOT_HOST";
    public const string NotInRoom = "NOT_IN_ROOM";
    public const string BadPhase = "BAD_PHASE";
    public const string NotYourTurn = "NOT_YOUR_TURN";
    public const string Stale = "STALE_ATTEMPT";
    public const string Duplicate = "DUPLICATE_ACTION";
    public const string Invalid = "INVALID_REQUEST";
    public const string TeamsUneven = "TEAMS_UNEVEN";
    public const string NotReady = "PLAYERS_NOT_READY";
    public const string TeamFull = "TEAM_FULL";
    public const string BadToken = "BAD_TOKEN";
    public const string RateLimited = "RATE_LIMITED";
    public const string ServerBusy = "SERVER_BUSY";
}

public sealed record GameEvent(string Type, string Text, Dictionary<string, object?>? Data = null);

public sealed record PlayerDto(string Id, string Name, string Team, bool Ready, bool Connected, bool IsHost, bool Left, bool IsBot);

public sealed record TossDto(string WinnerTeam, string ChooserId, string? Choice, double Deadline);

public sealed record PointDto(float X, float Z, float Distance);

public sealed record ResultDto(
    int AttemptId, string Outcome, string OutKind, string BatterId, string Team, string Reason,
    float Distance, int DistancePoints, int Bonus, int Points, int MissesAfter, int AttemptNumber,
    bool InningsEnded, bool MatchEnded, PointDto? Landing, PointDto? Rest);

public sealed record StatDto(int Points, int SafeHits, float Longest, string Out, bool HasBatted);

public sealed record MatchDto(
    int Innings, int TotalInnings, string BattingTeam, string FieldingTeam, int[] Scores,
    string? BatterId, int AttemptNumber, int Misses, int MaxMisses, int MaxAttempts,
    int AttemptId, string AttemptPhase, double? Deadline, string? ThrowerId, float Aim,
    PointDto? Landing, PointDto? Rest, bool TargetPresent, ResultDto? LastResult,
    bool Complete, string? Winner, bool ChaseCompleted,
    Dictionary<string, string[]> Lineups, Dictionary<string, StatDto> Stats);

public sealed record ClientConfigDto(
    float DandaLength, float CatchRadius, float CatchMaxHeight, float TargetRadius, int MaxMisses, int MaxAttempts,
    float GilliRadius, float GilliLength, float DandaRadius, float DandaInner, float DandaOuter,
    float PivotHeight, float PivotSideOffset, float SwingTilt, float SwingAngularSpeed, float SwingStartAngle, float SwingEndAngle,
    float MaxAimAngle, float Gravity, float AirDrag, float ThrowMinSpeed, float ThrowMaxSpeed, float ThrowMinPitch, float ThrowMaxPitch,
    float ThrowReleaseHeight, float MaxRunSpeed, float FixedStep);

public sealed record RoomStateDto(
    string Code, string Phase, bool Practice, string HostId, int MaxPlayers, List<PlayerDto> Players,
    TossDto? Toss, MatchDto? Match, ClientConfigDto Config, long Version, double ServerTime,
    string Mode, string Difficulty, int TeamSize);

public sealed record PlayerSnapDto(string Id, float X, float Z, float Yaw);

/// <summary>Compact motion snapshot. G = gilli [px,py,pz,qx,qy,qz,qw], Gv = [vx,vy,vz,wx,wy,wz], D = danda pose.</summary>
public sealed record SnapshotDto(double T, long Seq, string Ap, float[] G, float[] Gv, bool Air, bool Held, float[] D, List<PlayerSnapDto> P);

public sealed record JoinResultDto(string RoomCode, string PlayerId, string Token, RoomStateDto State);
