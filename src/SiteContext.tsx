import { createContext, useContext } from 'react';
import { DEFAULT_SITE, type SiteSettings } from '../shared/site-settings';
export type PublicSite = SiteSettings & { revision: number };
export const SiteContext = createContext<{ site: PublicSite; reload: () => Promise<void> }>({
  site: { revision: 0, ...DEFAULT_SITE },
  reload: async () => {},
});
export const useSite = () => useContext(SiteContext);
