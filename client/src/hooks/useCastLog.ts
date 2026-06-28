import { useEffect, useState } from 'react';
import {
  CastEvent,
  castDiagnosisHint,
  getCastEvents,
  subscribeCastLog,
} from '../utils/castLog';

export function useCastLog(): { events: CastEvent[]; hint: string | null } {
  const [events, setEvents] = useState<CastEvent[]>(() => getCastEvents());
  const [hint, setHint] = useState<string | null>(() => castDiagnosisHint());

  useEffect(() => {
    const refresh = () => {
      setEvents(getCastEvents());
      setHint(castDiagnosisHint());
    };
    return subscribeCastLog(refresh);
  }, []);

  return { events, hint };
}
