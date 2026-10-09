// Mirrors server/Gilli.Core/Rooms/Dtos.cs (SignalR JSON uses camelCase).

export type TeamId = 'A' | 'B';
export type RoomPhase = 'Lobby' | 'Toss' | 'Playing' | 'Finished';
export type AttemptPhase = 'Ready' | 'Popped' | 'InFlight' | 'AwaitThrow' | 'Throwing' | 'Result';

export interface OpResult<T = unknown> { ok: boolean; code?: string | null; error?: string | null; data?: T | null }

export interface PlayerDto { id: string; name: string; team: TeamId; ready: boolean; connected: boolean; isHost: boolean; left: boolean; isBot: boolean }
export type RoomMode = 'Online' | 'Practice' | 'VsComputer';
export type Difficulty = 'Easy' | 'Normal' | 'Hard';
export interface TossDto { winnerTeam: TeamId; chooserId: string; choice: 'bat' | 'field' | null; deadline: number }
export interface PointDto { x: number; z: number; distance: number }

export interface ResultDto {
  attemptId: number; outcome: 'Miss' | 'Safe' | 'Out'; outKind: string; batterId: string; team: TeamId; reason: string;
  distance: number; distancePoints: number; bonus: number; points: number; missesAfter: number; attemptNumber: number;
  inningsEnded: boolean; matchEnded: boolean; landing: PointDto | null; rest: PointDto | null;
}

export interface StatDto { points: number; safeHits: number; longest: number; out: string; hasBatted: boolean }

export interface MatchDto {
  innings: number; totalInnings: number; battingTeam: TeamId; fieldingTeam: TeamId; scores: [number, number];
  batterId: string | null; attemptNumber: number; misses: number; maxMisses: number; maxAttempts: number;
  attemptId: number; attemptPhase: AttemptPhase; deadline: number | null; throwerId: string | null; aim: number;
  landing: PointDto | null; rest: PointDto | null; targetPresent: boolean; lastResult: ResultDto | null;
  complete: boolean; winner: TeamId | null; chaseCompleted: boolean;
  lineups: Record<TeamId, string[]>; stats: Record<string, StatDto>;
}

export interface ClientConfig {
  dandaLength: number; catchRadius: number; catchMaxHeight: number; targetRadius: number; maxMisses: number; maxAttempts: number;
  gilliRadius: number; gilliLength: number; dandaRadius: number; dandaInner: number; dandaOuter: number;
  pivotHeight: number; pivotSideOffset: number; swingTilt: number; swingAngularSpeed: number; swingStartAngle: number; swingEndAngle: number;
  maxAimAngle: number; gravity: number; airDrag: number; throwMinSpeed: number; throwMaxSpeed: number; throwMinPitch: number; throwMaxPitch: number;
  throwReleaseHeight: number; maxRunSpeed: number; fixedStep: number;
}

export interface RoomState {
  code: string; phase: RoomPhase; practice: boolean; hostId: string; maxPlayers: number; players: PlayerDto[];
  toss: TossDto | null; match: MatchDto | null; config: ClientConfig; version: number; serverTime: number;
  mode: RoomMode; difficulty: Difficulty; teamSize: number;
}

export interface PlayerSnap { id: string; x: number; z: number; yaw: number }
export interface Snapshot { t: number; seq: number; ap: AttemptPhase; g: number[]; gv: number[]; air: boolean; held: boolean; d: number[]; p: PlayerSnap[] }

export interface GameEvent { type: string; text: string; data?: Record<string, unknown> | null }

export interface JoinResult { roomCode: string; playerId: string; token: string; state: RoomState }

export type ObstacleKind = 'Palm' | 'Neem' | 'Banyan' | 'Hut' | 'TeaShop' | 'Cart' | 'Wall' | 'WaterTank';
export interface Obstacle { kind: ObstacleKind; x: number; z: number; radius: number; width: number; depth: number; height: number; rotY: number; scale: number; isBox: boolean }
export interface FieldLayout { pit: { x: number; z: number }; boundary: { x: number; z: number; radius: number }; walkRadius: number; obstacles: Obstacle[] }

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
