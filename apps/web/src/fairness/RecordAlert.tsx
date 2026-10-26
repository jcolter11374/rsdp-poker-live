import { useEffect, useState } from 'react';
import { checkRecord, dismissRecordProblem, recordProblem } from '../audit';
import './fairness.css';

/** On every page: checks the public record now and then, and says so plainly if it was rewritten after this browser saw it. */
export function RecordAlert() {
  const [problem, setProblem] = useState(recordProblem);
  useEffect(() => {
    const run = () => checkRecord().then(() => setProblem(recordProblem()), () => {});
    void run();
    const t = setInterval(run, 15 * 60_000);
    return () => clearInterval(t);
  }, []);
  if (!problem || location.pathname.startsWith('/transparency')) return null;
  return (
    <div className="record-alert" role="alert">
      <b>The site&rsquo;s public record changed after your browser saw it.</b> Old hands, chip counts or admin actions may have been edited. <a href="/transparency">Details</a>
      <button
        onClick={() => {
          dismissRecordProblem();
          setProblem(null);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
