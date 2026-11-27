import { useCallback, useEffect, useRef, useState } from "react";
import App from "./App";
import { AccessContext, type AccessState } from "./access";
import { fetchAuthInfo, fetchMe, forgetToken, setUnauthorisedHandler, storedToken } from "./api/client";
import type { Me } from "./api/types";
import { tr, useLang } from "./i18n/lang";
import { PinScreen } from "./ui/PinScreen";

type Gate =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "pin"; example: string | null }
  | { kind: "in"; access: AccessState };

/** In front of the app: with teams (CIVIC_ENGAGEMENT_AUTH=pin), the PIN
 * screen until this browser has a valid token; without, the app at once. */
export function AccessGate() {
  useLang();
  const [gate, setGate] = useState<Gate>({ kind: "loading" });
  // The format's example, the PIN field's hint, once known.
  const exampleRef = useRef<string | null>(null);

  const toPinScreen = useCallback(() => setGate({ kind: "pin", example: exampleRef.current }), []);
  const changeTeam = useCallback(() => {
    forgetToken();
    toPinScreen();
  }, [toPinScreen]);
  // Who this is, asked again (the team's phase changed): the app shows and
  // hides its controls accordingly.
  const refresh = useCallback(() => {
    fetchMe()
      .then((me) => setGate((gate) => (gate.kind === "in" ? { kind: "in", access: { ...gate.access, me } } : gate)))
      .catch((err) => console.error(err));
  }, []);
  const enterAs = useCallback(
    (mechanism: AccessState["mechanism"], me: Me) =>
      setGate({ kind: "in", access: { mechanism, me, changeTeam, refresh } }),
    [changeTeam, refresh]
  );
  const enter = useCallback((me: Me) => enterAs("pin", me), [enterAs]);

  useEffect(() => {
    setUnauthorisedHandler(toPinScreen);
  }, [toPinScreen]);

  useEffect(() => {
    fetchAuthInfo()
      .then((info) => {
        if (info.mechanism === "open") {
          // No login; still asked, for the phase (CIVIC_ENGAGEMENT_PHASE).
          return fetchMe().then((me) => enterAs("open", me));
        }
        exampleRef.current = info.example;
        if (!storedToken()) {
          toPinScreen();
          return;
        }
        // A token from an earlier visit: still good unless refused.
        return fetchMe().then(enter, toPinScreen);
      })
      .catch((err) => {
        console.error(err);
        setGate({ kind: "failed" });
      });
  }, [enter, enterAs, toPinScreen]);

  switch (gate.kind) {
    case "loading":
      return null;
    case "failed":
      return (
        <div className="status-banner">
          {tr("Impossibile raggiungere il backend — è in esecuzione?", "Could not reach the backend — is it running?")}
        </div>
      );
    case "pin":
      return <PinScreen example={gate.example} onEnter={enter} />;
    case "in":
      return (
        <AccessContext.Provider value={gate.access}>
          <App />
        </AccessContext.Provider>
      );
  }
}
