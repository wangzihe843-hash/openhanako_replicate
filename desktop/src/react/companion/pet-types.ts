export interface PetContext {
  agentId: string;
  agentName: string;
  sessionPath: string;
  sessionId: string | null;
  connected: boolean;
  streaming: boolean;
  awaitingApproval: boolean;
  inlineError: boolean;
}

export interface PetWindowState {
  supported: boolean;
  visible: boolean;
  paused: boolean;
  clickThrough: boolean;
  alwaysOnTop: boolean;
  context: PetContext | null;
}

export type PetOptions = Partial<Pick<PetWindowState, 'paused' | 'clickThrough' | 'alwaysOnTop'>>;

export interface PetBridge {
  getState(): Promise<PetWindowState | null>;
  getConnection(): Promise<{ port: number | null; token: string | null } | null>;
  hide(): Promise<PetWindowState | null>;
  setOptions(options: PetOptions): Promise<PetWindowState | null>;
  openMain(): Promise<void>;
  onState(callback: (state: PetWindowState) => void): () => void;
  onContext(callback: (context: PetContext | null) => void): () => void;
  onResume(callback: () => void): () => void;
}
