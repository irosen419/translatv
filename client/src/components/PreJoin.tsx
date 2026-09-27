import { useEffect, useRef, useState } from "react";
import { DIALECTS } from "@translatv/shared";
import { detectCapabilities } from "../stt/WebSpeechAdapter.js";
import { parseImport } from "../lib/transcript.js";
import { useStore } from "../state/store.js";
import { useCopy } from "../i18n/useCopy.js";
import type { CopyRef } from "../i18n/copy.js";
import type { GlossaryEntry } from "@translatv/shared";

interface Props {
  mode: "create" | "join";
  code: string | null;
  onCancel(): void;
  onReady(input: {
    username: string;
    dialect: string;
    wantsVideo: boolean;
    glossary: GlossaryEntry[];
  }): void;
}

export function PreJoin({ mode, code, onCancel, onReady }: Props) {
  const [username, setUsername] = useState("");
  // The dialect picker IS the language control, by owner decision: what you speak is what you
  // read. So it writes straight into the store rather than holding a local copy, and the form
  // around it changes language as the select moves.
  const dialect = useStore((state) => state.uiDialect);
  const setDialect = useStore((state) => state.setUiDialect);
  const [wantsVideo, setWantsVideo] = useState(true);
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [importNote, setImportNote] = useState<CopyRef | null>(null);
  const [capability, setCapability] = useState<{
    supported: boolean;
    onDevice: boolean;
    notice?: CopyRef;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const copy = useCopy();

  useEffect(() => {
    let cancelled = false;
    void detectCapabilities(dialect)
      .then((caps) => {
        if (!cancelled) {
          setCapability({
            supported: caps.supported,
            onDevice: caps.onDeviceAvailable,
            ...(caps.notice !== undefined ? { notice: caps.notice } : {}),
          });
        }
      })
      // Every notice below is gated on `capability` being set, so a detection that never answers
      // renders NOTHING: not the warning, not the cloud line, not the on device line. That is
      // what an iPhone showed, and a blank space is the one outcome that tells the reader
      // nothing is wrong. detectCapabilities now bounds its own wait, so this is the second
      // line of defence rather than the fix, and it stays because the cost of being wrong here
      // is silence rather than an error.
      .catch(() => {
        if (!cancelled) {
          setCapability({ supported: false, onDevice: false, notice: { key: "stt.none" } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dialect]);

  async function onFile(file: File): Promise<void> {
    const result = parseImport(await file.text());
    if (result.ok) {
      setGlossary(result.glossary);
      // Two keys and a ternary rather than a pluralization engine. This is the only string in
      // the app that counts anything, and both languages split at exactly one, so the machinery
      // a full plural system brings would be carried entirely for this line.
      setImportNote(
        result.glossary.length === 1
          ? { key: "prejoin.glossary.loaded.one" }
          : { key: "prejoin.glossary.loaded.many", params: { count: result.glossary.length } },
      );
    } else {
      setGlossary([]);
      setImportNote(result.notice);
    }
  }

  const ready = username.trim().length > 0;

  return (
    <div className="center">
      <div className="card">
        <h1>{mode === "create" ? copy.t("prejoin.title.create") : copy.t("prejoin.title.join")}</h1>
        <p className="sub">
          {mode === "create"
            ? copy.t("prejoin.sub.create")
            : copy.t("prejoin.sub.join", { code: code ?? "" })}
        </p>

        {capability && !capability.supported && (
          <div className="notice bad">{copy.ref(capability.notice)}</div>
        )}
        {capability?.supported && !capability.onDevice && (
          <div className="notice">{copy.t("prejoin.stt.cloud")}</div>
        )}
        {capability?.onDevice && (
          <div className="notice" style={{ borderColor: "var(--accent)", background: "#0e1d1b", color: "#cdeee8" }}>
            {copy.t("prejoin.stt.onDevice")}
          </div>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) onReady({ username: username.trim(), dialect, wantsVideo, glossary });
          }}
        >
          <div className="field">
            <label htmlFor="name">{copy.t("prejoin.name.label")}</label>
            <input
              id="name"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              maxLength={24}
              autoComplete="off"
              placeholder={copy.t("prejoin.name.placeholder")}
            />
          </div>

          <div className="field">
            <label htmlFor="dialect">{copy.t("prejoin.dialect.label")}</label>
            <select
              id="dialect"
              value={dialect}
              onChange={(event) => setDialect(event.target.value)}
            >
              {DIALECTS.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.label}
                </option>
              ))}
            </select>
            {/* Each example is a whole clause inside its own <em>, rather than a sentence with
                three emphasised fragments spliced into it. Splicing needs the connecting words
                to sit in a fixed order, and they do not survive translation: the emphasis is
                worth keeping, the word order is not ours to fix. */}
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 0", lineHeight: 1.45 }}>
              {copy.t("prejoin.dialect.hint.lead")} <em>{copy.t("prejoin.dialect.hint.ar")}</em>,{" "}
              <em>{copy.t("prejoin.dialect.hint.mx")}</em>,{" "}
              <em>{copy.t("prejoin.dialect.hint.es")}</em>.
            </p>
          </div>

          <div className="field">
            <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={wantsVideo}
                onChange={(event) => setWantsVideo(event.target.checked)}
                style={{ width: "auto" }}
              />
              <span>{copy.t("prejoin.video")}</span>
            </label>
          </div>

          <div className="field">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              style={{ width: "100%" }}
            >
              {copy.t("prejoin.glossary.load")}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
            {importNote && (
              <p style={{ fontSize: 12, color: "var(--muted)", margin: "7px 0 0" }}>
                {copy.ref(importNote)}
              </p>
            )}
          </div>

          <div className="row" style={{ marginTop: 20 }}>
            <button type="button" onClick={onCancel} style={{ flex: "0 0 auto" }}>
              {copy.t("prejoin.back")}
            </button>
            <button type="submit" className="primary" disabled={!ready}>
              {mode === "create"
                ? copy.t("prejoin.submit.create")
                : copy.t("prejoin.submit.join")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
