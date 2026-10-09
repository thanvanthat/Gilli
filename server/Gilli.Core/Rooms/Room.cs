using System.Numerics;
using System.Security.Cryptography;
using Gilli.Core.Physics;
using Gilli.Core.Rules;

namespace Gilli.Core.Rooms;

public enum RoomPhase { Lobby, Toss, Playing, Finished }

public enum AttemptPhase { Ready, Popped, InFlight, AwaitThrow, Throwing, Result }

/// <summary>Online: 2–4 humans. Practice: one human batting alone. VsComputer: one human (plus CPU teammates) against a CPU side.</summary>
public enum RoomMode { Online, Practice, VsComputer }

public enum Difficulty { Easy, Normal, Hard }

public sealed class Player
{
    /// <summary>CPU player driven by the server (single-player mode). Uses the same validated actions as humans.</summary>
    public bool IsBot { get; init; }
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Token { get; init; }
    public required int JoinOrder { get; init; }
    public Team Team { get; set; }
    public bool Ready { get; set; }
    public bool Connected { get; set; } = true;
    public bool Left { get; set; }
    public string? ConnectionId { get; set; }
    public double DisconnectedAt { get; set; }
    public Vector2 Pos { get; set; }
    public float Yaw { get; set; }
    public double LastMoveAt { get; set; } = -1;
    public double CatchPressedAt { get; set; } = double.NegativeInfinity;
}

/// <summary>
/// One multiplayer room: lobby, toss, and the authoritative match. Every rule decision and every
/// physics step happens here on the server. Not thread-safe: callers hold <see cref="Sync"/>.
/// </summary>
public sealed partial class Room : IDisposable
{
    public object Sync { get; } = new();
    public string Code { get; }
    public RoomMode Mode { get; }
    public Difficulty Difficulty { get; }
    /// <summary>Players per team in a vs-computer match (1–3).</summary>
    public int TeamSize { get; }
    public bool Practice => Mode == RoomMode.Practice;
    public bool VsComputer => Mode == RoomMode.VsComputer;
    public GameConfig Config { get; }
    public FieldLayout Layout { get; }
    public RoomPhase Phase { get; private set; } = RoomPhase.Lobby;
    public double Now { get; private set; }
    public string HostId { get; private set; } = "";
    public long Version { get; private set; }
    public bool StateDirty { get; private set; } = true;
    public IReadOnlyList<Player> Players => players;
    public MatchRules? Rules => rules;
    public GilliWorld? World => world;
    public AttemptPhase AttemptPhase => attempt.Phase;
    public int AttemptId => attempt.Id;
    public double LastActivity { get; private set; }

    readonly List<Player> players = new();
    readonly List<GameEvent> events = new();
    readonly Random rng;
    int joinCounter;
    long snapshotSeq;

    // toss
    Team tossWinner;
    string tossChooser = "";
    string? tossChoice;
    double tossDeadline;

    // match
    MatchRules? rules;
    GilliWorld? world;
    double physicsAccumulator;
    int lastInningsIndex = -1;
    ResultDto? lastResult;

    sealed class AttemptState
    {
        public int Id;
        public AttemptPhase Phase = AttemptPhase.Ready;
        public bool Resolved;
        public bool Flicked, Swung;
        public double PhaseStart, Deadline;
        public float Aim;
        public bool Landed;
        public Vector3 LaunchPoint, LandingPoint, RestPoint;
        public float RestDistance;
        public string? ThrowerId;
        public bool Thrown, ThrowLanded;
        public string? HeldBy;
        public double ResultUntil;
    }
    AttemptState attempt = new();

    RulesConfig R => Config.Rules;
    PhysicsConfig P => Config.Physics;

    public Room(string code, bool practice, GameConfig? config = null, FieldLayout? layout = null, Random? random = null)
        : this(code, practice ? RoomMode.Practice : RoomMode.Online, config, layout, random) { }

    public Room(string code, RoomMode mode, GameConfig? config = null, FieldLayout? layout = null, Random? random = null,
        Difficulty difficulty = Difficulty.Normal, int teamSize = 1)
    {
        Code = code;
        Mode = mode;
        Difficulty = difficulty;
        TeamSize = Math.Clamp(teamSize, 1, 3);
        Config = config ?? GameConfig.Default;
        Layout = layout ?? FieldLayout.Default;
        rng = random ?? new Random();
    }

    /// <summary>How many humans may sit in the room.</summary>
    int Capacity => Mode == RoomMode.Online ? Config.MaxPlayers : 1;
    IEnumerable<Player> Humans => players.Where(p => !p.IsBot);
    public bool HasHumans => Humans.Any(p => !p.Left);
    public bool IsAbandoned => Humans.All(p => !p.Connected || p.Left);
    public Player? Find(string id) => players.FirstOrDefault(p => p.Id == id);
    public Player? FindByConnection(string connectionId) => players.FirstOrDefault(p => p.ConnectionId == connectionId);

    void Dirty() { StateDirty = true; LastActivity = Now; }
    void Emit(string type, string text, Dictionary<string, object?>? data = null) => events.Add(new GameEvent(type, text, data));

    public List<GameEvent> DrainEvents()
    {
        var copy = events.ToList();
        events.Clear();
        return copy;
    }

    // ------------------------------------------------------------------ lobby

    public static string? ValidateName(string? name)
    {
        name = name?.Trim();
        if (string.IsNullOrEmpty(name) || name.Length > 16) return null;
        if (name.Any(ch => char.IsControl(ch) || ch == '<' || ch == '>')) return null;
        // invisible formatting characters (bidi overrides, zero-width spaces) let one name impersonate another;
        // ZWNJ/ZWJ (U+200C/U+200D) stay allowed because Tamil and other scripts use them
        if (name.Any(ch => char.GetUnicodeCategory(ch) == System.Globalization.UnicodeCategory.Format && ch is not ('‌' or '‍'))) return null;
        return name;
    }

    public OpResult AddPlayer(string? rawName, string connectionId, out Player? player)
    {
        player = null;
        var name = ValidateName(rawName);
        if (name is null) return OpResult.Fail(ErrorCodes.InvalidName, "Enter a name of 1 to 16 characters.");
        if (Phase != RoomPhase.Lobby) return OpResult.Fail(ErrorCodes.InProgress, "That room is already playing a match.");
        var active = players.Where(p => !p.Left).ToList();
        if (active.Count(p => !p.IsBot) >= Capacity)
            return OpResult.Fail(ErrorCodes.Full, Mode == RoomMode.Online ? "That room is full (4 players)." : "Single-player rooms are for one player.");
        if (active.Any(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)))
            name = $"{name[..Math.Min(name.Length, 13)]} {active.Count + 1}";

        int a = active.Count(p => p.Team == Team.A), b = active.Count(p => p.Team == Team.B);
        player = new Player
        {
            Id = NewId(6),
            Name = name,
            Token = NewId(16), // 128-bit secret from a CSPRNG: proves seat ownership on reconnect
            JoinOrder = joinCounter++,
            Team = Mode != RoomMode.Online || a <= b ? Team.A : Team.B,
            ConnectionId = connectionId,
            Ready = Mode != RoomMode.Online,
        };
        player.Pos = Layout.WaitingSpots[active.Count % Layout.WaitingSpots.Count];
        players.Add(player);
        if (string.IsNullOrEmpty(HostId) || Find(HostId) is not { Left: false }) HostId = player.Id;
        Emit("join", $"{player.Name} joined Team {player.Team}", new() { ["playerId"] = player.Id });
        if (VsComputer && !players.Any(p => p.IsBot)) AddBots();
        Dirty();
        return OpResult.Success();
    }

    public OpResult Reconnect(string playerId, string token, string connectionId)
    {
        var p = Find(playerId);
        if (p is null || p.Left) return OpResult.Fail(ErrorCodes.NotInRoom, "Your seat in this room has expired.");
        if (p.IsBot || !TokenMatches(p.Token, token)) return OpResult.Fail(ErrorCodes.BadToken, "Reconnect token rejected.");
        bool was = p.Connected;
        p.Connected = true;
        p.ConnectionId = connectionId;
        if (!was) Emit("reconnect", $"{p.Name} reconnected", new() { ["playerId"] = p.Id });
        Dirty();
        return OpResult.Success();
    }

    static string NewId(int bytes) => Convert.ToHexString(RandomNumberGenerator.GetBytes(bytes)).ToLowerInvariant();

    /// <summary>Constant-time comparison so response timing does not leak how much of a token was right.</summary>
    static bool TokenMatches(string expected, string? supplied)
    {
        if (supplied is null) return false;
        var a = System.Text.Encoding.UTF8.GetBytes(expected);
        var b = System.Text.Encoding.UTF8.GetBytes(supplied);
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }

    public void MarkDisconnected(string playerId)
    {
        var p = Find(playerId);
        if (p is null || !p.Connected) return;
        p.Connected = false;
        p.ConnectionId = null;
        p.DisconnectedAt = Now;
        Emit("disconnect", $"{p.Name} disconnected", new() { ["playerId"] = p.Id });
        Dirty();
    }

    public void Leave(string playerId)
    {
        var p = Find(playerId);
        if (p is null || p.Left) return;
        p.Connected = false;
        p.ConnectionId = null;
        Emit("leave", $"{p.Name} left the room", new() { ["playerId"] = p.Id });
        if (Phase is RoomPhase.Lobby or RoomPhase.Finished or RoomPhase.Toss)
        {
            players.Remove(p);
            if (Phase == RoomPhase.Toss) { Phase = RoomPhase.Lobby; Emit("info", "Toss cancelled: a player left"); }
        }
        else
        {
            p.Left = true;
            HandleAbsentDuringMatch(p);
        }
        MigrateHost();
        Dirty();
    }

    void MigrateHost()
    {
        if (Find(HostId) is { Left: false, Connected: true }) return;
        var next = Humans.Where(x => !x.Left && x.Connected).OrderBy(x => x.JoinOrder).FirstOrDefault()
                   ?? Humans.Where(x => !x.Left).OrderBy(x => x.JoinOrder).FirstOrDefault();
        if (next is not null && next.Id != HostId)
        {
            HostId = next.Id;
            Emit("host", $"{next.Name} is now the host", new() { ["playerId"] = next.Id });
        }
    }

    public OpResult SetTeam(string playerId, Team team)
    {
        if (Phase != RoomPhase.Lobby) return OpResult.Fail(ErrorCodes.BadPhase, "Teams can only change in the lobby.");
        if (Mode != RoomMode.Online) return OpResult.Fail(ErrorCodes.Invalid, "Teams are fixed in single-player modes.");
        var p = Find(playerId)!;
        if (p.Team == team) return OpResult.Success();
        if (players.Count(x => !x.Left && x.Team == team) >= 2) return OpResult.Fail(ErrorCodes.TeamFull, $"Team {team} already has 2 players.");
        p.Team = team;
        p.Ready = false;
        Dirty();
        return OpResult.Success();
    }

    public OpResult SetReady(string playerId, bool ready)
    {
        if (Phase != RoomPhase.Lobby) return OpResult.Fail(ErrorCodes.BadPhase, "Ready only applies in the lobby.");
        Find(playerId)!.Ready = ready;
        Dirty();
        return OpResult.Success();
    }

    public OpResult StartMatch(string playerId)
    {
        if (playerId != HostId) return OpResult.Fail(ErrorCodes.NotHost, "Only the host can start the match.");
        if (Phase != RoomPhase.Lobby) return OpResult.Fail(ErrorCodes.BadPhase, "The match has already started.");
        var active = players.Where(p => !p.Left).ToList();
        if (active.Any(p => !p.Connected)) return OpResult.Fail(ErrorCodes.NotReady, "Wait for disconnected players to return or leave.");
        if (Practice) { BeginPlaying(Team.A); return OpResult.Success(); }
        if (VsComputer) { StartToss(); return OpResult.Success(); }

        int a = active.Count(p => p.Team == Team.A), b = active.Count(p => p.Team == Team.B);
        if (active.Count < 2) return OpResult.Fail(ErrorCodes.TeamsUneven, "You need at least 2 players. Share the room code!");
        if (a != b) return OpResult.Fail(ErrorCodes.TeamsUneven, $"Teams must be even (1 v 1 or 2 v 2). Now: Team A {a}, Team B {b}.");
        var notReady = active.Where(p => p.Id != HostId && !p.Ready).Select(p => p.Name).ToList();
        if (notReady.Count > 0) return OpResult.Fail(ErrorCodes.NotReady, $"Waiting for {string.Join(", ", notReady)} to be ready.");

        StartToss();
        return OpResult.Success();
    }

    void StartToss()
    {
        Phase = RoomPhase.Toss;
        tossWinner = rng.Next(2) == 0 ? Team.A : Team.B;
        tossChoice = null;
        tossChooser = players.Where(p => !p.Left && p.Team == tossWinner).OrderBy(p => p.JoinOrder).First().Id;
        tossDeadline = Now + R.TossChoiceTimeLimit;
        Emit("toss", $"Team {tossWinner} won the toss", new() { ["winner"] = tossWinner.ToString(), ["chooserId"] = tossChooser });
        Dirty();
    }

    public OpResult ChooseToss(string playerId, bool bat)
    {
        if (Phase != RoomPhase.Toss || tossChoice is not null) return OpResult.Fail(ErrorCodes.BadPhase, "There is no toss decision to make.");
        var p = Find(playerId)!;
        var chooser = Find(tossChooser);
        bool allowed = p.Id == tossChooser || (chooser is { Connected: false } && p.Team == tossWinner);
        if (!allowed) return OpResult.Fail(ErrorCodes.NotYourTurn, "Only the toss winner's captain chooses.");
        DecideToss(bat, $"{p.Name} chose to {(bat ? "bat" : "field")}");
        return OpResult.Success();
    }

    void DecideToss(bool bat, string text)
    {
        tossChoice = bat ? "bat" : "field";
        Emit("tossChoice", text, new() { ["choice"] = tossChoice, ["winner"] = tossWinner.ToString() });
        BeginPlaying(bat ? tossWinner : MatchRules.Other(tossWinner));
    }

    void BeginPlaying(Team firstBatting)
    {
        var active = players.Where(p => !p.Left).OrderBy(p => p.JoinOrder).ToList();
        rules = new MatchRules(R, active.Where(p => p.Team == Team.A).Select(p => p.Id), active.Where(p => p.Team == Team.B).Select(p => p.Id), firstBatting);
        world?.Dispose();
        world = new GilliWorld(P, Layout);
        physicsAccumulator = 0;
        lastInningsIndex = -1;
        lastResult = null;
        attempt = new AttemptState { Id = 0 };
        Phase = RoomPhase.Playing;
        Emit("matchStart", $"Team {firstBatting} bats first", new() { ["battingTeam"] = firstBatting.ToString() });
        NextAttempt();
    }

    public OpResult PlayAgain(string playerId)
    {
        if (playerId != HostId) return OpResult.Fail(ErrorCodes.NotHost, "Only the host can restart.");
        if (Phase != RoomPhase.Finished) return OpResult.Fail(ErrorCodes.BadPhase, "The match is not finished.");
        players.RemoveAll(p => p.Left);
        if (Practice) { BeginPlaying(Team.A); Dirty(); return OpResult.Success(); }
        if (VsComputer) { StartToss(); return OpResult.Success(); }
        int a = players.Count(p => p.Team == Team.A), b = players.Count(p => p.Team == Team.B);
        if (a != b || a == 0 || players.Any(p => !p.Connected))
        {
            BackToLobbyInternal();
            return OpResult.Fail(ErrorCodes.TeamsUneven, "Not everyone is here: back to the lobby to rebalance teams.");
        }
        StartToss();
        return OpResult.Success();
    }

    public OpResult BackToLobby(string playerId)
    {
        if (playerId != HostId) return OpResult.Fail(ErrorCodes.NotHost, "Only the host can return the room to the lobby.");
        if (Phase is not (RoomPhase.Finished or RoomPhase.Toss)) return OpResult.Fail(ErrorCodes.BadPhase, "Finish the match first.");
        BackToLobbyInternal();
        return OpResult.Success();
    }

    void BackToLobbyInternal()
    {
        Phase = RoomPhase.Lobby;
        players.RemoveAll(p => p.Left);
        foreach (var p in players) p.Ready = Mode != RoomMode.Online;
        world?.Dispose(); world = null;
        rules = null;
        Emit("lobby", "Back in the lobby");
        Dirty();
    }

    // ------------------------------------------------------------------ attempts

    void NextAttempt()
    {
        if (rules is null || world is null) return;
        if (rules.IsComplete) { Finish(); return; }
        var batter = Find(rules.CurrentBatter!)!;
        attempt = new AttemptState { Id = attempt.Id + 1, Phase = AttemptPhase.Ready, PhaseStart = Now, Deadline = Now + R.FlickTimeLimit, Aim = attempt.Aim };
        world.ResetForAttempt(attempt.Aim);
        PlaceBatter(batter);

        if (rules.InningsIndex != lastInningsIndex)
        {
            lastInningsIndex = rules.InningsIndex;
            int i = 0, w = 0;
            foreach (var p in players.Where(p => !p.Left).OrderBy(p => p.JoinOrder))
            {
                if (p.Id == batter.Id) continue;
                if (p.Team == rules.FieldingTeam) { p.Pos = Layout.FieldingSpots[i++ % Layout.FieldingSpots.Count]; p.Yaw = MathF.Atan2(-p.Pos.X, -p.Pos.Y); }
                else p.Pos = Layout.WaitingSpots[w++ % Layout.WaitingSpots.Count];
                p.LastMoveAt = -1;
            }
            Emit("innings", $"Innings {rules.InningsIndex + 1}: Team {rules.BattingTeam} bats", new() { ["battingTeam"] = rules.BattingTeam.ToString(), ["innings"] = rules.InningsIndex + 1 });
        }
        Emit("attempt", $"{batter.Name} to bat · attempt {rules.AttemptNumber}", new() { ["attemptId"] = attempt.Id, ["batterId"] = batter.Id });
        Dirty();
    }

    void PlaceBatter(Player batter)
    {
        var rig = world!.Rig;
        batter.Pos = new Vector2(rig.BatterFeet.X, rig.BatterFeet.Z);
        batter.Yaw = rig.BatterYaw;
    }

    OpResult CheckAttemptAction(string playerId, int attemptId, AttemptPhase phase, bool batterOnly)
    {
        if (Phase != RoomPhase.Playing || rules is null || world is null) return OpResult.Fail(ErrorCodes.BadPhase, "No match in progress.");
        if (attemptId != attempt.Id) return OpResult.Fail(ErrorCodes.Stale, "That action was for a previous attempt.");
        if (attempt.Resolved) return OpResult.Fail(ErrorCodes.Stale, "This attempt is already decided.");
        if (batterOnly && rules.CurrentBatter != playerId) return OpResult.Fail(ErrorCodes.NotYourTurn, "It is not your turn to bat.");
        if (attempt.Phase != phase) return OpResult.Fail(ErrorCodes.BadPhase, $"Not now (the gilli is {attempt.Phase}).");
        return OpResult.Success();
    }

    public OpResult Aim(string playerId, float aim)
    {
        if (!float.IsFinite(aim)) return OpResult.Fail(ErrorCodes.Invalid, "Bad aim.");
        if (Phase != RoomPhase.Playing || rules?.CurrentBatter != playerId) return OpResult.Fail(ErrorCodes.NotYourTurn, "Not batting.");
        if (attempt.Phase != AttemptPhase.Ready) return OpResult.Fail(ErrorCodes.BadPhase, "Aim is locked once the gilli is flicked.");
        attempt.Aim = Math.Clamp(aim, -P.MaxAimAngle, P.MaxAimAngle);
        world!.SetAim(attempt.Aim);
        PlaceBatter(Find(playerId)!);
        return OpResult.Success();
    }

    public OpResult Flick(string playerId, int attemptId)
    {
        var check = CheckAttemptAction(playerId, attemptId, AttemptPhase.Ready, true);
        if (!check.Ok) return attempt.Flicked && attemptId == attempt.Id ? OpResult.Fail(ErrorCodes.Duplicate, "Already flicked.") : check;
        attempt.Flicked = true;
        world!.Flick();
        SetAttemptPhase(AttemptPhase.Popped);
        Emit("flick", "Flick!", new() { ["attemptId"] = attempt.Id, ["t"] = Now });
        return OpResult.Success();
    }

    public OpResult Swing(string playerId, int attemptId)
    {
        var check = CheckAttemptAction(playerId, attemptId, AttemptPhase.Popped, true);
        if (!check.Ok) return check;
        if (attempt.Swung) return OpResult.Fail(ErrorCodes.Duplicate, "Only one swing per attempt.");
        attempt.Swung = true;
        world!.StartSwing();
        Emit("swing", "Swing!", new() { ["attemptId"] = attempt.Id, ["t"] = Now, ["aim"] = attempt.Aim });
        return OpResult.Success();
    }

    public OpResult Catch(string playerId, int attemptId)
    {
        if (Phase != RoomPhase.Playing || rules is null) return OpResult.Fail(ErrorCodes.BadPhase, "No match in progress.");
        var p = Find(playerId)!;
        if (p.Team != rules.FieldingTeam) return OpResult.Fail(ErrorCodes.NotYourTurn, "Only fielders can catch.");
        if (attemptId != attempt.Id) return OpResult.Fail(ErrorCodes.Stale, "That catch was for a previous attempt.");
        if (attempt.Phase is not (AttemptPhase.InFlight or AttemptPhase.Popped)) return OpResult.Fail(ErrorCodes.BadPhase, "Nothing to catch.");
        // cooldown: spamming catch must not keep the catch window permanently open
        if (Now - p.CatchPressedAt < R.CatchCooldown) return OpResult.Fail(ErrorCodes.Duplicate, "Catch is recovering.");
        p.CatchPressedAt = Now;
        TryCatch(); // immediate check; also re-checked every physics step within the window
        return OpResult.Success();
    }

    public OpResult Throw(string playerId, int attemptId, float yaw, float pitch, float power)
    {
        if (!float.IsFinite(yaw) || !float.IsFinite(pitch) || !float.IsFinite(power)) return OpResult.Fail(ErrorCodes.Invalid, "Bad throw.");
        if (Phase != RoomPhase.Playing) return OpResult.Fail(ErrorCodes.BadPhase, "No match in progress.");
        if (attemptId != attempt.Id) return OpResult.Fail(ErrorCodes.Stale, "That throw was for a previous attempt.");
        if (attempt.Phase != AttemptPhase.AwaitThrow) return OpResult.Fail(attempt.Thrown ? ErrorCodes.Duplicate : ErrorCodes.BadPhase, "Not waiting for a throw.");
        if (attempt.ThrowerId != playerId) return OpResult.Fail(ErrorCodes.NotYourTurn, "Another fielder is throwing.");
        attempt.Thrown = true;
        var release = attempt.RestPoint with { Y = P.ThrowReleaseHeight };
        world!.Throw(release, yaw, pitch, Math.Clamp(power, 0, 1));
        var thrower = Find(playerId)!;
        thrower.Yaw = yaw;
        SetAttemptPhase(AttemptPhase.Throwing);
        Emit("throw", $"{thrower.Name} throws at the danda!", new() { ["playerId"] = playerId, ["power"] = power });
        return OpResult.Success();
    }

    public OpResult Move(string playerId, float x, float z, float yaw)
    {
        if (!float.IsFinite(x) || !float.IsFinite(z) || !float.IsFinite(yaw)) return OpResult.Fail(ErrorCodes.Invalid, "Bad position.");
        var p = Find(playerId);
        if (p is null) return OpResult.Fail(ErrorCodes.NotInRoom, "Not in room.");
        p.Yaw = yaw;
        if (Phase == RoomPhase.Playing && rules is not null)
        {
            if (rules.CurrentBatter == playerId) return OpResult.Success(); // the batter stands at the crease
            if (attempt.Phase == AttemptPhase.AwaitThrow && attempt.ThrowerId == playerId) return OpResult.Success(); // throws from where the gilli lies
        }
        var target = new Vector2(x, z);
        // speed validation: the browser predicts movement, the server only accepts plausible steps
        double dt = p.LastMoveAt < 0 ? 0.25 : Math.Clamp(Now - p.LastMoveAt, 0.016, 0.5);
        float maxStep = P.MaxRunSpeed * (float)dt * 1.35f + 0.3f;
        var delta = target - p.Pos;
        if (delta.Length() > maxStep) target = p.Pos + Vector2.Normalize(delta) * maxStep;
        p.Pos = Layout.ConstrainPlayer(target, P.PlayerRadius);
        p.LastMoveAt = Now;
        return OpResult.Success();
    }

    void SetAttemptPhase(AttemptPhase phase)
    {
        attempt.Phase = phase;
        attempt.PhaseStart = Now;
        Dirty();
    }

    // ------------------------------------------------------------------ simulation

    public void Tick(double dt)
    {
        dt = Math.Clamp(dt, 0, 0.25);
        Now += dt;
        // lobby: drop players whose disconnect grace expired
        if (Phase is RoomPhase.Lobby or RoomPhase.Finished)
        {
            var expired = players.Where(p => !p.Connected && Now - p.DisconnectedAt > R.DisconnectGrace).ToList();
            foreach (var p in expired) { players.Remove(p); Emit("leave", $"{p.Name} timed out"); }
            if (expired.Count > 0) { MigrateHost(); Dirty(); }
        }
        else if (Phase == RoomPhase.Toss)
        {
            if (tossChoice is null && Find(tossChooser) is { IsBot: true } bot && Now >= tossDeadline - R.TossChoiceTimeLimit + 2.0)
            {
                bool bat = rng.NextDouble() < 0.6;
                DecideToss(bat, $"{bot.Name} (CPU) chose to {(bat ? "bat" : "field")}");
            }
            else if (Now >= tossDeadline && tossChoice is null) DecideToss(true, "No choice in time: the toss winner bats");
        }
        else if (Phase == RoomPhase.Playing && world is not null)
        {
            physicsAccumulator += dt;
            while (physicsAccumulator >= P.FixedStep && Phase == RoomPhase.Playing)
            {
                physicsAccumulator -= P.FixedStep;
                var report = world.Step();
                ProcessStep(report);
            }
            CheckTimers();
            if (Phase == RoomPhase.Playing && VsComputer) UpdateBots(dt);
        }
    }

    void ProcessStep(StepReport report)
    {
        var w = world!;
        if (attempt.HeldBy is { } holder && Find(holder) is { } h)
            w.PlaceGilli(new Vector3(h.Pos.X, 1.25f, h.Pos.Y), w.Gilli.Orientation, Vector3.Zero, Vector3.Zero);

        switch (attempt.Phase)
        {
            case AttemptPhase.Popped:
                if (report.DandaHit)
                {
                    attempt.LaunchPoint = w.Gilli.Position;
                    SetAttemptPhase(AttemptPhase.InFlight);
                    Emit("hit", $"Struck! {report.HitSpeed:F1} m/s", new() { ["speed"] = report.HitSpeed, ["x"] = report.HitPoint.X, ["y"] = report.HitPoint.Y, ["z"] = report.HitPoint.Z });
                }
                else if (report.GroundContact && Now - attempt.PhaseStart > 0.2 && !w.Swinging)
                    ResolveMiss(attempt.Swung ? "Swung and missed" : "The gilli dropped before you swung");
                break;

            case AttemptPhase.InFlight:
                TryCatch();
                if (attempt.Phase != AttemptPhase.InFlight) break;
                if (report.GroundContact && !attempt.Landed)
                {
                    attempt.Landed = true;
                    attempt.LandingPoint = report.GroundPoint;
                    float d = Horizontal(report.GroundPoint);
                    Emit("landed", $"Landed {d:F1} m from the pit", new() { ["x"] = report.GroundPoint.X, ["z"] = report.GroundPoint.Z, ["distance"] = d });
                    Dirty();
                }
                if (w.AtRest || Now - attempt.PhaseStart > P.MaxFlightTime) OnGilliRested();
                break;

            case AttemptPhase.Throwing:
                if (report.TargetContact) { ResolveTargetHit("direct hit on the danda"); break; }
                if (report.GroundContact && !attempt.ThrowLanded)
                {
                    attempt.ThrowLanded = true;
                    if (Horizontal(report.GroundPoint) <= R.TargetRadius) { ResolveTargetHit("landed on the target"); break; }
                }
                if ((w.AtRest && Now - attempt.PhaseStart > 0.5) || Now - attempt.PhaseStart > 6)
                    ResolveSafe("The throw missed the danda");
                break;
        }
    }

    static float Horizontal(Vector3 p) => new Vector2(p.X, p.Z).Length();

    void TryCatch()
    {
        if (attempt.Phase != AttemptPhase.InFlight || attempt.Landed || attempt.Resolved || rules is null || world is null) return;
        if (Now - attempt.PhaseStart < 0.15) return; // still on the bat
        var g = world.Gilli.Position;
        if (g.Y < R.CatchMinHeight || g.Y > R.CatchMaxHeight) return;
        foreach (var p in players)
        {
            if (p.Left || p.Team != rules.FieldingTeam || Now - p.CatchPressedAt > R.CatchAttemptWindow) continue;
            if (Vector2.Distance(p.Pos, new Vector2(g.X, g.Z)) > R.CatchRadius) continue;
            attempt.HeldBy = p.Id;
            world.PlaceGilli(new Vector3(p.Pos.X, 1.25f, p.Pos.Y), world.Gilli.Orientation, Vector3.Zero, Vector3.Zero);
            Emit("caught", $"Caught by {p.Name}!", new() { ["playerId"] = p.Id });
            Resolve(rules.RecordCatch(p.Name));
            return;
        }
    }

    void OnGilliRested()
    {
        var g = world!.Gilli.Position;
        attempt.RestPoint = new Vector3(g.X, 0, g.Z);
        attempt.RestDistance = Horizontal(g);
        if (!attempt.Landed) { attempt.Landed = true; attempt.LandingPoint = attempt.RestPoint; }
        Emit("rest", $"Gilli stopped {attempt.RestDistance:F2} m from the pit", new() { ["x"] = g.X, ["z"] = g.Z, ["distance"] = attempt.RestDistance });

        if (g.Z > 0.5f) { ResolveMiss("Mishit: the gilli went behind the batting line"); return; }
        if (attempt.RestDistance < R.MinScoringDistance) { ResolveMiss($"Mishit: the gilli stopped inside {R.MinScoringDistance:F0} m"); return; }

        // the fielder nearest the gilli picks it up and throws at the danda from there
        var thrower = players.Where(p => !p.Left && p.Connected && p.Team == rules!.FieldingTeam)
            .OrderBy(p => Vector2.Distance(p.Pos, new Vector2(g.X, g.Z))).FirstOrDefault();
        if (thrower is null) { ResolveSafe("No fielder to throw"); return; }
        attempt.ThrowerId = thrower.Id;
        thrower.Pos = new Vector2(g.X, g.Z);
        thrower.Yaw = MathF.Atan2(-g.X, -g.Z);
        thrower.LastMoveAt = -1;
        world.SetTarget(true);
        attempt.Deadline = Now + R.ThrowTimeLimit;
        SetAttemptPhase(AttemptPhase.AwaitThrow);
        Emit("throwTurn", $"{thrower.Name} throws from {attempt.RestDistance:F1} m", new() { ["playerId"] = thrower.Id });
    }

    void CheckTimers()
    {
        if (rules is null || Phase != RoomPhase.Playing) return;
        switch (attempt.Phase)
        {
            case AttemptPhase.Ready:
                var batter = Find(rules.CurrentBatter!)!;
                if (batter.Left || (!batter.Connected && Now - batter.DisconnectedAt > R.DisconnectGrace))
                    Resolve(rules.RetireBatter($"{batter.Name} left the match"));
                else if (Now >= attempt.Deadline && batter.Connected)
                    ResolveMiss("Took too long to flick");
                break;
            case AttemptPhase.Popped:
                if (Now - attempt.PhaseStart > 3) ResolveMiss("The gilli dropped before you swung");
                break;
            case AttemptPhase.AwaitThrow:
                var t = Find(attempt.ThrowerId!);
                if (Now >= attempt.Deadline || t is null || t.Left || (!t.Connected && Now - t.DisconnectedAt > 5))
                    ResolveSafe("No throw in time");
                break;
            case AttemptPhase.Result:
                if (Now >= attempt.ResultUntil) NextAttempt();
                break;
        }
        CheckForfeit();
    }

    void CheckForfeit()
    {
        if (rules is null || rules.IsComplete || Practice) return;
        foreach (var team in new[] { Team.A, Team.B })
        {
            var members = players.Where(p => p.Team == team).ToList();
            if (members.Count > 0 && members.All(p => p.Left || (!p.Connected && Now - p.DisconnectedAt > R.DisconnectGrace)))
            {
                rules.Forfeit(team);
                Emit("forfeit", $"Team {team} left the match");
                Finish();
                return;
            }
        }
    }

    void HandleAbsentDuringMatch(Player p)
    {
        if (rules is null || rules.IsComplete) return;
        if (rules.CurrentBatter == p.Id && attempt.Phase == AttemptPhase.Ready && !attempt.Resolved)
            Resolve(rules.RetireBatter($"{p.Name} left the match"));
        CheckForfeit();
    }

    void ResolveMiss(string reason) { if (!attempt.Resolved) Resolve(rules!.RecordMiss(reason)); }

    void ResolveTargetHit(string how)
    {
        if (attempt.Resolved) return;
        var t = Find(attempt.ThrowerId!)!;
        Emit("targetHit", $"{t.Name}'s throw {how}!", new() { ["playerId"] = t.Id });
        Resolve(rules!.RecordTargetHit(t.Name));
    }

    void ResolveSafe(string reason)
    {
        if (attempt.Resolved) return;
        Resolve(rules!.RecordSafeHit(attempt.RestDistance, reason));
    }

    /// <summary>Records the result of the current attempt. Guarded so an attempt resolves exactly once.</summary>
    void Resolve(AttemptResult r)
    {
        if (attempt.Resolved) return;
        attempt.Resolved = true;
        world?.SetTarget(attempt.Phase == AttemptPhase.Throwing || attempt.Phase == AttemptPhase.AwaitThrow);
        PointDto? landing = attempt.Landed ? new PointDto(attempt.LandingPoint.X, attempt.LandingPoint.Z, Horizontal(attempt.LandingPoint)) : null;
        PointDto? rest = attempt.RestDistance > 0 ? new PointDto(attempt.RestPoint.X, attempt.RestPoint.Z, attempt.RestDistance) : null;
        lastResult = new ResultDto(attempt.Id, r.Outcome.ToString(), r.OutKind.ToString(), r.BatterId, r.Team.ToString(), r.Reason,
            r.Distance, r.DistancePoints, r.Bonus, r.Points, r.MissesAfter, r.AttemptNumber, r.InningsEnded, r.MatchEnded, landing, rest);
        attempt.ResultUntil = Now + R.ResultDisplayTime;
        SetAttemptPhase(AttemptPhase.Result);
        var batter = Find(r.BatterId);
        string title = r.Outcome switch
        {
            AttemptOutcome.Safe => $"Safe! +{r.Points}",
            AttemptOutcome.Miss => "Miss",
            _ => r.OutKind == OutKind.Retired || r.OutKind == OutKind.AttemptLimit ? "Retired" : "OUT!"
        };
        Emit("result", $"{title} · {batter?.Name}: {r.Reason}", new() { ["result"] = lastResult });
    }

    void Finish()
    {
        Phase = RoomPhase.Finished;
        foreach (var p in players) p.Ready = Mode != RoomMode.Online;
        var w = rules!.Winner;
        string text = Practice ? $"Practice over: {rules.Scores[0]} points"
            : w is null ? "Match drawn"
            : VsComputer ? (w == Team.A ? "You beat the computer!" : "The computer wins!")
            : $"Team {w} wins!";
        Emit("matchEnd", text, new() { ["winner"] = w?.ToString(), ["scores"] = rules.Scores.ToArray() });
        Dirty();
    }

    // ------------------------------------------------------------------ DTOs

    /// <summary>Builds the full room state. Pass broadcast=false when the state only goes to one caller, so the pending broadcast is not lost.</summary>
    public RoomStateDto BuildState(bool broadcast = true)
    {
        if (broadcast) StateDirty = false;
        Version++;
        var playerDtos = players.OrderBy(p => p.JoinOrder)
            .Select(p => new PlayerDto(p.Id, p.Name, p.Team.ToString(), p.Ready, p.Connected, p.Id == HostId, p.Left, p.IsBot)).ToList();
        TossDto? toss = Phase == RoomPhase.Toss || (tossChoice is not null && Phase != RoomPhase.Lobby)
            ? new TossDto(tossWinner.ToString(), tossChooser, tossChoice, tossDeadline) : null;
        MatchDto? match = null;
        if (rules is not null && Phase is RoomPhase.Playing or RoomPhase.Finished)
        {
            PointDto? landing = attempt.Landed ? new PointDto(attempt.LandingPoint.X, attempt.LandingPoint.Z, Horizontal(attempt.LandingPoint)) : null;
            PointDto? rest = attempt.RestDistance > 0 ? new PointDto(attempt.RestPoint.X, attempt.RestPoint.Z, attempt.RestDistance) : null;
            double? deadline = attempt.Phase is AttemptPhase.Ready or AttemptPhase.AwaitThrow ? attempt.Deadline : null;
            match = new MatchDto(
                Math.Min(rules.InningsIndex + 1, rules.TotalInnings), rules.TotalInnings, rules.BattingTeam.ToString(), rules.FieldingTeam.ToString(),
                rules.Scores.ToArray(), rules.CurrentBatter, rules.AttemptNumber, rules.ConsecutiveMisses, R.MaxConsecutiveMisses, R.MaxAttemptsPerBatter,
                attempt.Id, attempt.Phase.ToString(), deadline, attempt.ThrowerId, attempt.Aim, landing, rest, world?.TargetPresent ?? false, lastResult,
                rules.IsComplete, rules.Winner?.ToString(), rules.ChaseCompleted,
                new Dictionary<string, string[]> { ["A"] = rules.Lineup(Team.A).ToArray(), ["B"] = rules.Lineup(Team.B).ToArray() },
                rules.Stats.ToDictionary(kv => kv.Key, kv => new StatDto(kv.Value.Points, kv.Value.SafeHits, kv.Value.Longest, kv.Value.Out.ToString(), kv.Value.HasBatted)));
        }
        return new RoomStateDto(Code, Phase.ToString(), Practice, HostId, Capacity, playerDtos, toss, match, ClientConfig(Config), Version, Now, Mode.ToString(), Difficulty.ToString(), TeamSize);
    }

    public static ClientConfigDto ClientConfig(GameConfig c) => new(
        c.Rules.DandaLength, c.Rules.CatchRadius, c.Rules.CatchMaxHeight, c.Rules.TargetRadius, c.Rules.MaxConsecutiveMisses, c.Rules.MaxAttemptsPerBatter,
        c.Physics.GilliRadius, c.Physics.GilliLength, c.Physics.DandaRadius, c.Physics.DandaInner, c.Physics.DandaOuter,
        c.Physics.PivotHeight, c.Physics.PivotSideOffset, c.Physics.SwingTilt, c.Physics.SwingAngularSpeed, c.Physics.SwingStartAngle, c.Physics.SwingEndAngle,
        c.Physics.MaxAimAngle, c.Physics.Gravity, c.Physics.AirDrag, c.Physics.ThrowMinSpeed, c.Physics.ThrowMaxSpeed, c.Physics.ThrowMinPitch, c.Physics.ThrowMaxPitch,
        c.Physics.ThrowReleaseHeight, c.Physics.MaxRunSpeed, c.Physics.FixedStep);

    public SnapshotDto? BuildSnapshot()
    {
        if (Phase is RoomPhase.Lobby or RoomPhase.Toss || world is null) return null;
        var g = world.Gilli;
        var (dp, dq) = world.DandaPose;
        var list = players.Where(p => !p.Left).Select(p => new PlayerSnapDto(p.Id, p.Pos.X, p.Pos.Y, p.Yaw)).ToList();
        return new SnapshotDto(Math.Round(Now, 4), ++snapshotSeq, attempt.Phase.ToString(),
            new[] { g.Position.X, g.Position.Y, g.Position.Z, g.Orientation.X, g.Orientation.Y, g.Orientation.Z, g.Orientation.W },
            new[] { g.Velocity.X, g.Velocity.Y, g.Velocity.Z, g.AngularVelocity.X, g.AngularVelocity.Y, g.AngularVelocity.Z },
            !world.InGroundContact, attempt.HeldBy is not null,
            new[] { dp.X, dp.Y, dp.Z, dq.X, dq.Y, dq.Z, dq.W }, list);
    }

    /// <summary>True when the gilli is moving and clients need high-rate snapshots.</summary>
    public bool HighRate => Phase == RoomPhase.Playing && attempt.Phase is AttemptPhase.Popped or AttemptPhase.InFlight or AttemptPhase.Throwing;

    public void Dispose() => world?.Dispose();
}
