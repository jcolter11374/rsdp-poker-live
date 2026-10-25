import { useEffect, useState } from 'react';

/** Phones, and windows taller than they are wide, get the one-column table. */
export function usePortrait() {
  const query = '(max-width: 700px), (max-aspect-ratio: 4/5)';
  const [portrait, setPortrait] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setPortrait(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return portrait;
}
