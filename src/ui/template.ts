import { icon } from "./icons";

/**
 * Static shadow-DOM markup. Dynamic bits (menu panel contents, quality
 * lists, caption tracks) are rendered by ControlsController at runtime —
 * this stays a fixed skeleton so it can be cached as a single template.
 */
export function renderShell(): string {
  return /* html */ `
    <div class="lumen" part="root" tabindex="0" role="region">
      <video class="lumen-media" part="media" playsinline></video>

      <div class="lumen-captions" part="captions" aria-hidden="true"></div>

      <div class="lumen-poster" part="poster" hidden></div>

      <div class="lumen-center">
        <div class="lumen-spinner" part="spinner" role="status" aria-label="Loading" hidden></div>
        <button type="button" class="lumen-big-play" part="big-play" data-action="play-pause" aria-label="Play">
          ${icon("play")}
        </button>
      </div>

      <!--
        Overlay slot. A shadow root renders none of its host's light-DOM
        children unless they're slotted, so without this anything a plugin
        or an application appends to <lumen-player> would exist but never
        be displayed. Sits above the video and below the controls.
      -->
      <div class="lumen-overlay" part="overlay"><slot></slot></div>

      <div class="lumen-error" part="error" hidden role="alert">
        ${icon("alert")}
        <p data-el="error-message"></p>
        <button type="button" data-action="retry">${icon("refresh")} Try again</button>
      </div>

      <div class="lumen-controls" part="controls">
        <div class="lumen-progress" part="progress" role="slider" tabindex="0"
             aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-el="progress">
          <div class="lumen-preview" data-el="preview">
            <img data-el="preview-img" alt="" />
            <span class="lumen-preview-chapter" data-el="preview-chapter" hidden></span>
            <span class="lumen-preview-time" data-el="preview-time">0:00</span>
          </div>
          <div class="lumen-progress-track">
            <div class="lumen-progress-buffered" data-el="buffered"></div>
            <div class="lumen-progress-fill" data-el="fill"></div>
            <div class="lumen-progress-chapters" data-el="chapter-marks"></div>
            <div class="lumen-progress-thumb"></div>
          </div>
        </div>

        <div class="lumen-row">
          <div class="lumen-row-start">
            <button type="button" class="lumen-btn" part="button" data-action="previous" aria-label="Previous" hidden>
              ${icon("previous")}
            </button>
            <button type="button" class="lumen-btn" part="button" data-action="play-pause" aria-label="Play">
              ${icon("play")}
            </button>
            <button type="button" class="lumen-btn" part="button" data-action="next" aria-label="Next" hidden>
              ${icon("next")}
            </button>
            <div class="lumen-volume">
              <button type="button" class="lumen-btn" part="button" data-action="mute" aria-label="Mute">
                ${icon("volume-high")}
              </button>
              <div class="lumen-volume-slider">
                <input type="range" data-el="volume" min="0" max="1" step="0.01" value="1" aria-label="Volume" />
              </div>
            </div>
            <span class="lumen-time" data-el="time" aria-hidden="true">0:00 / 0:00</span>
          </div>

          <div class="lumen-spacer"></div>

          <div class="lumen-row-end">
            <button type="button" class="lumen-btn" part="button" data-action="captions-toggle" aria-label="Captions" aria-pressed="false" hidden>
              ${icon("captions")}
            </button>
            <button type="button" class="lumen-btn" part="button" data-action="cast" aria-label="Cast" hidden>
              ${icon("cast")}
            </button>
            <button type="button" class="lumen-btn" part="button" data-action="pip" aria-label="Picture in picture" hidden>
              ${icon("pip")}
            </button>
            <button type="button" class="lumen-btn" part="button" data-action="settings" aria-label="Settings" aria-haspopup="menu" aria-expanded="false">
              ${icon("settings")}
            </button>
            <button type="button" class="lumen-btn" part="button" data-action="fullscreen" aria-label="Fullscreen">
              ${icon("fullscreen")}
            </button>
          </div>
        </div>
      </div>

      <div class="lumen-menu" part="menu" role="menu" data-el="menu" hidden></div>

      <span class="lumen-sr-only" role="status" aria-live="polite" data-el="announcer"></span>
    </div>
  `;
}
