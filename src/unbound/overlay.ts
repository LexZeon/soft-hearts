/**
 * Unbound U1: the developer overlay: in developer mode with 网格 on, her floor grid, where she stands, and her hit capsules (the
 * reply bubble and the other small things beside her head are in bubbles.ts). Nothing here takes the mouse (pointer-events: none),
 * so clicks still go through.
 */
import { GridHelper, Group, Mesh, MeshBasicMaterial, RingGeometry, type Scene } from 'three';
import type { Capsule2D } from '../../shared/unbound/hit-test';
import { UNITS_PER_M } from './figure';
import { gazeDebug } from '../senses';

/** Developer overlay: floor grid (1 m squares), a ring at her feet, the capsules, and one line of numbers. */
export class DebugOverlay {
  private readonly group = new Group();
  private readonly ring: Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly line: HTMLDivElement;
  private shown = false;
  constructor(scene: Scene, parent: HTMLElement) {
    const grid = new GridHelper(30 * UNITS_PER_M, 30, 0x7fb4ff, 0x4d6d99);
    grid.position.set(0, 0, -15 * UNITS_PER_M);
    for (const material of [grid.material].flat()) { material.transparent = true; material.opacity = 0.55; }
    this.ring = new Mesh(new RingGeometry(0.28 * UNITS_PER_M, 0.34 * UNITS_PER_M, 40), new MeshBasicMaterial({ color: 0xff8fb5, transparent: true, opacity: 0.8 }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.01 * UNITS_PER_M;
    this.group.add(grid, this.ring);
    this.group.visible = false;
    scene.add(this.group);
    const doc = parent.ownerDocument;
    this.canvas = doc.createElement('canvas'); this.canvas.className = 'unbound-debug-capsules'; this.canvas.hidden = true;
    this.line = doc.createElement('div'); this.line.className = 'unbound-debug-line'; this.line.hidden = true;
    parent.append(this.canvas, this.line);
  }
  setVisible(on: boolean): void {
    this.shown = on; this.group.visible = on; this.canvas.hidden = !on; this.line.hidden = !on;
    if (!on) { this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height); gazeDebug(this, false); } // I-169: the gaze label and dot go with the overlay
  }
  get visible(): boolean { return this.shown; }
  /** Her feet (scene units) and the numbers line. */
  update(feetX: number, feetZ: number, text: string): void {
    if (!this.shown) return;
    this.ring.position.x = feetX; this.ring.position.z = feetZ;
    this.line.textContent = text;
  }
  drawCapsules(capsules: readonly Capsule2D[], width: number, height: number, interactive: boolean): void {
    if (!this.shown) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) { this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio); }
    const g = this.canvas.getContext('2d');
    if (!g) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);
    g.strokeStyle = interactive ? 'rgba(255,120,170,0.75)' : 'rgba(120,190,255,0.55)';
    g.lineCap = 'round';
    for (const c of capsules) {
      g.lineWidth = Math.max(1, c.r * 2);
      g.globalAlpha = 0.18;
      g.beginPath(); g.moveTo(c.ax, c.ay); g.lineTo(c.bx + 0.01, c.by); g.stroke();
    }
    g.globalAlpha = 1;
  }
}
