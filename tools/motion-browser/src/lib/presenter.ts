/**
 * Presenter engine bootstrap + typed handle for the `<sv-presenter>` web
 * component. The engine URL is resolved from the server (`/api/config`), so the
 * same build can target any CDN. See `docs/presenter.d.ts` in the sample for the
 * full IPresentationWidget contract.
 */

import { getConfig } from "./api";

export interface PresentationResult {
  success: boolean;
  code: string;
  message?: string;
}

export type PresentationTarget = {
  type: "explicit";
  avatarId: string;
  sceneId: string;
  voiceId?: string;
};

/** Subset of IPresentationWidget used by this app. */
export interface Presenter extends HTMLElement {
  initialize(connectToken: string, target: PresentationTarget): Promise<void>;
  present(content: string): Promise<PresentationResult>;
  interruptPresentation(): void;
  resumeAudioPlayback(): Promise<void>;
  refreshConnectToken(token: string): void;
  setListening(isListening: boolean): void;
  setThinking(isThinking: boolean): void;
  updateCameraFOV(fov: {
    distance: number;
    vertical: number;
    horizontal: number;
  }): void;
  playMotion(motionId: string): Promise<void>;
}

let enginePromise: Promise<void> | null = null;

/**
 * Load the presenter engine `<script type="module">` once. Resolves after the
 * module has loaded and `<sv-presenter>` is registered as a custom element.
 */
export function loadPresenterEngine(): Promise<void> {
  if (!enginePromise) {
    enginePromise = getConfig().then(
      ({ presenterUrl }) =>
        new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.type = "module";
          script.src = presenterUrl;
          script.onload = () => resolve();
          script.onerror = () =>
            reject(
              new Error(`Failed to load presenter engine from ${presenterUrl}`),
            );
          document.head.append(script);
        }),
    );
  }
  return enginePromise;
}
