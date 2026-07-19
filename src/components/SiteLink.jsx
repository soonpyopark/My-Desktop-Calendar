import { SITE_URL } from '../../shared/constants.js';
import { openExternalUrl } from '../lib/openExternal.js';

export default function SiteLink() {
  return (
    <a
      href={SITE_URL}
      className="text-xs text-gcal-muted transition-colors hover:text-gcal-blue hover:underline"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void openExternalUrl(SITE_URL);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {SITE_URL}
    </a>
  );
}
