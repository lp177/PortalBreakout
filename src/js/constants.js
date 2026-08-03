// PortalBreakout — shared constants (see CONTRACT.md)

export const FIELD_W = 780, FIELD_H = 1100;      // logical units; canvas scales to fit
export const GRID_COLS = 13, GRID_ROWS = 14;      // brick grid
export const BRICK_W = 60, BRICK_H = 34;
export const GRID_TOP = 260;                      // y of first brick row
export const PADDLE_W = 120, PADDLE_H = 18, PADDLE_W_EXPANDED = 180;
export const PADDLE_TOP_Y = 70, PADDLE_BOTTOM_Y = 1030;  // paddle center-line y
export const PADDLE_SPEED = 700;                  // px/s for keyboard control
export const BALL_R = 9, BALL_SPEED = 420, BALL_SPEED_MAX = 900;
export const SPEED_UP = 1.04, PORTAL_ENGLISH = 120;  // vx += offset * PORTAL_ENGLISH on teleport
export const MIN_VY_RATIO = 0.25;                 // anti horizontal-lock: |vy| >= ratio*speed
export const POWERUP_SPEED = 170, POWERUP_R = 16, POWERUP_DROP_CHANCE = 0.11;
export const LIVES_START = 3, MAX_BALLS = 6;
export const STORAGE_SETTINGS = 'pb.settings.v1', STORAGE_PROGRESS = 'pb.progress.v1';

// URL of a TURN-credentials endpoint (see server/turn/ and README "Multiplayer
// troubleshooting"). Empty = disabled; the game then relies on public STUN and
// best-effort public relays only. Example: 'https://turn.example.com/ice'
export const ICE_ENDPOINT = 'https://lp177.fr/ice';

// Versus mode (see CONTRACT.md "Versus mode")
export const VS_LIVES = 3, VS_LIFE_MAX = 5;
export const VS_RAMP_RATE = 0.008, VS_RAMP_MAX = 1.9, VS_BALL_SPEED_MAX = 1150;
export const AI_PROFILES = {   // top-paddle AI tuning
  easy:   { speed: 420, err: 60, react: 0.35 },   // px/s, aim error px, re-aim interval s
  normal: { speed: 560, err: 35, react: 0.22 },
  hard:   { speed: 700, err: 18, react: 0.12 },
};
