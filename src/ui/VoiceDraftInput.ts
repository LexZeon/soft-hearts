/** Own only text this recovery path placed into the existing input. Different
 * groups and manually edited drafts always keep their separate visible copy. */
export class VoiceDraftInput {
  private key = '';
  private text = '';
  place(input: { value: string }, key: string, text: string): boolean {
    if (input.value && (this.key !== key || input.value !== this.text)) return false;
    input.value = text; this.key = key; this.text = text;
    return true;
  }
  clear(input: { value: string }): void {
    if (this.key && input.value === this.text) input.value = '';
    this.key = ''; this.text = '';
  }
}
