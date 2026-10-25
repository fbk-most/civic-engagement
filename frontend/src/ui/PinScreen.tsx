import { useState, type FormEvent } from "react";
import { loginWithPin, TooManyAttemptsError } from "../api/client";
import type { Me } from "../api/types";
import { tr, useLang } from "../i18n/lang";
import { activePack } from "../pack";
import { LangSwitch } from "./LangSwitch";

interface Props {
  /** An example of the PINs' format, as the field's hint. */
  example: string | null;
  onEnter: (me: Me) => void;
}

/** The one field between a member and their team's scene: the PIN the
 * manager gave them, which says the team and the role. */
export function PinScreen({ example, onEnter }: Props) {
  const lang = useLang();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!pin.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const login = await loginWithPin(pin);
      if (login) onEnter(login);
      else setError(tr("Codice non valido.", "Not a valid code."));
    } catch (err) {
      console.error(err);
      setError(
        err instanceof TooManyAttemptsError
          ? tr(`Troppi tentativi: riprova tra ${err.seconds} s.`, `Too many attempts: try again in ${err.seconds} s.`)
          : tr("Impossibile verificare il codice.", "Could not check the code.")
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pin-screen">
      <div className="pin-screen__lang">
        <LangSwitch lang={lang} />
      </div>
      <form className="pin-screen__form" onSubmit={handleSubmit}>
        <h1>{activePack().title}</h1>
        <label htmlFor="pin">{tr("Codice", "Code")}</label>
        <input
          id="pin"
          type="text"
          value={pin}
          autoFocus
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={example ? tr(`es. ${example}`, `e.g. ${example}`) : ""}
          onChange={(event) => setPin(event.target.value)}
        />
        <button type="submit" disabled={busy || !pin.trim()}>
          {tr("Entra", "Enter")}
        </button>
        {error && <p className="pin-screen__error">{error}</p>}
      </form>
    </div>
  );
}
