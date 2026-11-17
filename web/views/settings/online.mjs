// Settings › Online: sharing your screen with the other players, Discord live runs, the stream overlays' coffee hint.
import { html } from '/vendor/htm-preact.mjs';
import { t } from '../../lib/i18n.mjs';
import { api } from '../../lib/api.mjs';
import { LiveRunsSettings } from '../liveshare.mjs';
import { Item, Group, Check, Elsewhere } from './parts.mjs';

export function OnlineSection({ cfg, save, toast, reloadStatus }) {
  const coffee = async (on) => {
    try {
      await api.post('/api/stream', { coffee: on });
      reloadStatus?.();
    } catch {
      toast({ kind: 'warn', title: t('set.saveFailed', 'Couldn’t save the setting') });
    }
  };
  return html`
    <${Group} title=${t('set.withPlayers', 'With the other players')}>
      <${Item} id="share-screen"><${Check} checked=${cfg.shareScreen !== false} onChange=${(v) => save({ shareScreen: v })}
        label=${t('set.shareScreenAll', 'Share my screen with the other players')}
        hint=${t('set.shareScreenHint', 'While you play, the others see your game small in a corner. It is only sent while someone is watching.')} /><//>
      <${Elsewhere} icon="signal">${t('set.connElsewhere', 'Invite codes, relays and who is online:')} <a href="#/link">${t('nav.link', 'Connection')}</a><//>
    <//>
    <${Group} title="Discord"><${Item} id="discord"><${LiveRunsSettings} /><//><//>
    <${Group} title=${t('nav.stream', 'Stream')}>
      <${Item} id="coffee-pop"><${Check} checked=${cfg.stream?.coffee !== false} onChange=${coffee}
        label=${t('set.coffeePop', 'Coffee hint on legendary encounters in stream overlays')}
        hint=${t('set.coffeePopHint', 'Now and then a cheeky toast about the legendary pops up in your Alerts overlay, with the coffee link.')} /><//>
      <${Elsewhere} icon="stream">${t('set.streamElsewhere', 'Streamer mode, OBS overlays and their links:')} <a href="#/stream">${t('nav.stream', 'Stream')}</a><//>
    <//>`;
}
