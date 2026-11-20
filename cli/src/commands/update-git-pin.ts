import fs from 'node:fs';
import { payloadPathFor, type InstallManifest, type InstallStorePaths } from '../install-store.js';
export type PinnedGitUpdateOptions={gitSha?:string;expectedCurrentSha?:string;expectedRollbackSha?:string;rollbackOnFailure?:boolean;canary?:boolean;latest?:boolean;version?:string;rollback?:boolean;check?:boolean};
const sha=/^[0-9a-f]{40}$/;
/** New fork functionality. It never changes the recorded repository/ref. */
export function validatePinnedGitUpdate(options:PinnedGitUpdateOptions):void{
 if(options.rollback && options.check)throw Error("--rollback cannot be combined with --check; no source was changed.");
 if(options.rollback && options.expectedCurrentSha!==undefined){
  if(!sha.test(options.expectedCurrentSha)||!options.expectedRollbackSha||!sha.test(options.expectedRollbackSha)||options.gitSha||options.canary||options.latest||options.version)throw Error('Exact rollback requires full expected-current and expected-rollback Git SHAs only.');
  return;
 }
 if(options.expectedRollbackSha!==undefined)throw Error('--expected-rollback-sha requires exact managed rollback.');
 if(options.gitSha===undefined){if(options.expectedCurrentSha!==undefined||options.rollbackOnFailure===false)throw Error('Pinned Git guards require --git-sha.');return;}
 if(!sha.test(options.gitSha)||!options.expectedCurrentSha||!sha.test(options.expectedCurrentSha))throw Error('--git-sha and --expected-current-sha require full lowercase 40-character Git SHAs.');
 if(options.canary||options.latest||options.version||options.rollback)throw Error('--git-sha cannot be combined with npm channels/version or rollback.');
}
export function assertPinnedGitManifest(manifest:InstallManifest|null,options:PinnedGitUpdateOptions):void{
 if(!options.gitSha)return;
 if(!manifest||manifest.source!=='git'||!manifest.repo||!manifest.ref||manifest.sha!==options.expectedCurrentSha)throw Error('Pinned Git update requires the unchanged expected managed Git source.');
}
/** Refuse cached 12-character native payloads whose complete source is unknown.
 * Do not delete/rebuild unknown data or claim a version smoke test proves SHA. */
export function assertPinnedGitCache(manifest:InstallManifest,target:string,paths:InstallStorePaths):void{
 const cached=payloadPathFor(paths,'git',target.slice(0,12));if(!fs.existsSync(cached))return;
 if(![manifest,...manifest.previous].some(record=>record.source==='git'&&record.repo===manifest.repo&&record.sha===target&&record.payloadPath===cached))throw Error('Cached Git payload lacks exact repository/SHA provenance; engineering review required.');
}
export function assertUnchangedPinnedGitSource(current:InstallManifest|null,admitted:InstallManifest,options:PinnedGitUpdateOptions):void{
 if(!options.gitSha)return;assertPinnedGitManifest(current,options);
 if(!current||current.repo!==admitted.repo||current.ref!==admitted.ref||current.payloadPath!==admitted.payloadPath)throw Error('Managed Git source changed after update admission.');
}

/** Native store lock must own both source and target comparisons. */
export function assertPinnedGitRollback(manifest:InstallManifest|null,options:PinnedGitUpdateOptions):void{
 if(!options.rollback||options.expectedCurrentSha===undefined)return;
 if(!manifest||manifest.source!=="git"||manifest.sha!==options.expectedCurrentSha||!manifest.repo)throw Error("Exact rollback current Git source changed.");
 const previous=manifest.previous[0];
 if(!previous||previous.source!=="git"||previous.sha!==options.expectedRollbackSha||previous.repo!==manifest.repo)throw Error("Exact rollback retained Git target changed.");
}
