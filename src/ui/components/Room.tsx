/** Live with friends (live.html): open a room, share its links, let guests in. */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { MAX_GUESTS, MAX_VIEWERS, peers, room } from "../../live/room-state";
import { engine } from "../../studio/engine";
import { Icon } from "./Icons";

const load = () => import("../../live/room");

function CopyLink(props: {
  label: string;
  hint: string;
  value: string;
  testid: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div class="field">
      <span class="field-label">{props.label}</span>
      <div class="code-row">
        <input readOnly value={props.value} aria-label={props.label} data-testid={props.testid} />
        <button
          type="button"
          class="btn sm"
          onClick={() =>
            void navigator.clipboard?.writeText(props.value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          <Icon name="copy" size={15} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <span class="field-hint">{props.hint}</span>
    </div>
  );
}

function AddByCode(): JSX.Element {
  const [code, setCode] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <details class="manual">
      <summary>Add someone by code</summary>
      <p class="small muted">
        When a friend cannot get through the relays, their page shows a code. Paste it here, then
        send them the answer.
      </p>
      <form
        class="code-row"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          setAnswer(null);
          void load()
            .then((m) => m.answerCode(code))
            .then((a) => {
              setAnswer(a);
              setCode("");
            })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        }}
      >
        <input
          value={code}
          placeholder="obscura-g.… or obscura-w.…"
          aria-label="Their join code"
          onInput={(e) => setCode(e.currentTarget.value)}
          data-testid="peer-code"
        />
        <button type="submit" class="btn sm" disabled={!code.trim()} data-testid="peer-code-add">
          Add
        </button>
      </form>
      {answer && (
        <CopyLink
          label="Answer to send back"
          hint="Valid for two minutes."
          value={answer}
          testid="peer-answer"
        />
      )}
      {error && (
        <p class="error small" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}

export function RoomPanel(): JSX.Element {
  const state = room.value;
  const list = peers.value;
  const [turnUrl, setTurnUrl] = useState("");
  const [turnUser, setTurnUser] = useState("");
  const [turnPass, setTurnPass] = useState("");
  const guests = list.filter((p) => p.role === "guest");
  const viewers = list.filter((p) => p.role === "viewer");

  const openRoom = () => {
    const en = engine;
    if (!en) return;
    void en.mixer.resume();
    const turn = /^turns?:/.test(turnUrl.trim())
      ? { urls: turnUrl.trim(), username: turnUser, credential: turnPass }
      : null;
    void load().then((m) => m.startRoom(en, turn));
  };

  return (
    <section class="panel room-panel" aria-labelledby="room-title" data-testid="room-panel">
      <header class="panel-head">
        <h2 id="room-title">Live with friends</h2>
        {state.kind === "on" && (
          <span class="badge" title="Public relays that pass on the connection details">
            {state.relays}/{state.total} relays
          </span>
        )}
      </header>
      {state.kind !== "on" ? (
        <div class="stack">
          <p class="small muted">
            Friends with the guest link appear on screen next to you; anyone with the viewer link
            watches. Video goes peer to peer; the links' keys never leave this page.
          </p>
          <details class="manual">
            <summary>TURN server (optional)</summary>
            <p class="small muted">For friends behind strict firewalls. Kept in memory only.</p>
            <input
              placeholder="turn:turn.example.com:3478"
              value={turnUrl}
              aria-label="TURN URL"
              onInput={(e) => setTurnUrl(e.currentTarget.value)}
            />
            <input
              placeholder="Username"
              value={turnUser}
              autocomplete="off"
              aria-label="TURN username"
              onInput={(e) => setTurnUser(e.currentTarget.value)}
            />
            <input
              type="password"
              placeholder="Credential"
              value={turnPass}
              autocomplete="off"
              aria-label="TURN credential"
              onInput={(e) => setTurnPass(e.currentTarget.value)}
            />
          </details>
          <button
            type="button"
            class="btn btn-primary"
            disabled={state.kind === "starting"}
            onClick={openRoom}
            data-testid="open-room"
          >
            <Icon name="users" size={16} />
            {state.kind === "starting" ? "Opening…" : "Open a room"}
          </button>
        </div>
      ) : (
        <div class="stack">
          <CopyLink
            label="Guest link"
            hint={`Puts a friend on screen, once you let them in (up to ${MAX_GUESTS}).`}
            value={state.guestLink}
            testid="guest-link"
          />
          <CopyLink
            label="Viewer link"
            hint={`Watch only (up to ${MAX_VIEWERS}).`}
            value={state.viewerLink}
            testid="viewer-link"
          />
          {guests.length > 0 && (
            <ul class="peers" aria-label="Guests" data-testid="guests">
              {guests.map((p) => (
                <li key={p.id} class="peer">
                  <span class={p.state === "connected" ? "dot dot-live" : "dot"} />
                  <span class="peer-name">{p.name}</span>
                  {p.state === "asking" ? (
                    <>
                      <button
                        type="button"
                        class="btn sm btn-primary"
                        onClick={() => void load().then((m) => m.accept(p.id))}
                        data-testid="accept-guest"
                      >
                        Let in
                      </button>
                      <button
                        type="button"
                        class="btn sm"
                        onClick={() => void load().then((m) => m.drop(p.id))}
                      >
                        Decline
                      </button>
                    </>
                  ) : (
                    <>
                      <span class="small muted">
                        {p.state === "connected" ? "on screen" : "connecting…"}
                      </span>
                      <button
                        type="button"
                        class="icon-btn xs"
                        aria-label={`Remove ${p.name}`}
                        title="Remove"
                        onClick={() => void load().then((m) => m.drop(p.id))}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p class="small muted" data-testid="viewer-count">
            {viewers.filter((v) => v.state === "connected").length} watching
          </p>
          <div class="btn-row">
            <button
              type="button"
              class="btn sm"
              onClick={() => engine?.splitScreen()}
              data-testid="split-screen"
            >
              <Icon name="grid" size={15} /> Split screen
            </button>
            <button
              type="button"
              class="btn sm btn-stop"
              onClick={() => void load().then((m) => m.stopRoom())}
              data-testid="close-room"
            >
              Close room
            </button>
          </div>
          <AddByCode />
        </div>
      )}
    </section>
  );
}
