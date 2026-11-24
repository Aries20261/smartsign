import { adminClient, BUCKET } from './supabase';

/** Penyimpanan berkas privat (Supabase Storage). Browser hanya menerima URL bertanda tangan berumur pendek. */
export async function putFile(path: string, bytes: Uint8Array, contentType: string) {
  const { error } = await adminClient().storage.from(BUCKET).upload(path, bytes, { contentType, upsert: false });
  if (error) throw new Error('storage.upload: ' + error.message);
}
export async function getFile(path: string): Promise<Uint8Array> {
  const { data, error } = await adminClient().storage.from(BUCKET).download(path);
  if (error || !data) throw new Error('storage.download: ' + (error?.message || 'kosong'));
  return new Uint8Array(await data.arrayBuffer());
}
export async function moveFile(from: string, to: string) {
  const { error } = await adminClient().storage.from(BUCKET).move(from, to);
  if (error) throw new Error('storage.move: ' + error.message);
}
export async function removeFiles(paths: string[]) {
  if (!paths.length) return;
  const { error } = await adminClient().storage.from(BUCKET).remove(paths);
  if (error) console.warn(JSON.stringify({ storage: 'remove', msg: error.message }));
}
export async function signedUrl(path: string, seconds: number, downloadName?: string): Promise<string> {
  const { data, error } = await adminClient().storage.from(BUCKET).createSignedUrl(path, seconds, downloadName ? { download: downloadName } : undefined);
  if (error || !data) throw new Error('storage.signedUrl: ' + (error?.message || 'kosong'));
  return data.signedUrl;
}
export async function signedUploadUrl(path: string): Promise<{ url: string; token: string }> {
  const { data, error } = await adminClient().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error('storage.signedUploadUrl: ' + (error?.message || 'kosong'));
  return { url: data.signedUrl, token: data.token };
}
