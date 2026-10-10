'use client';

import type { CSSProperties } from 'react';

export const expertColors = ['#78a7ff', '#67f2ba', '#ffc77b', '#be95ff', '#ff89ba', '#7ae4f5', '#d6ed83', '#eda797'];

export default function FusionCore({ weights, labels, names, busy, cells, layers, cloudConnected = false, cloudRttMs, cloudExecution = false }: {
  weights: Record<string, number>; labels: Record<string, string>; names: string[];
  busy: boolean; cells?: number[]; layers?: number;
  cloudConnected?: boolean; cloudRttMs?: number | null; cloudExecution?: boolean;
}) {
  const height = Math.max(240, names.length * 54);
  const peak = Math.max(...(cells || []).map(Math.abs), .000001);
  return <div className={`neural-core ${busy ? 'processing' : ''}`} role="img"
    aria-label={`Fusion Core: Edge laptop to Outshift cloud server and back. ${cloudConnected ? 'Cloud connected' : 'Cloud unavailable'}. ${names.filter(name => weights[name] > 0).map(name => `${labels[name]} ${((weights[name] || 0) * 100).toFixed(1)} percent`).join(', ')} merging into the base model`}>
    <div className="core-topline flex items-center justify-between gap-3"><span>NEURAL FUSION CORE</span><span>{busy ? 'COMPUTING' : layers ? 'FUSION VERIFIED' : 'WEIGHT PREVIEW'}</span></div>
    <div className={`distributed-flow ${cloudConnected ? 'cloud-link-up' : 'cloud-link-down'} ${busy ? 'flow-busy' : ''}`}>
      <svg viewBox="0 0 620 150" className="distributed-canvas" aria-hidden="true">
        <rect x="8" y="36" width="146" height="80" rx="8" fill="#111f25" stroke="#78a7ff" strokeOpacity=".65"/>
        <rect x="35" y="50" width="27" height="19" rx="2" fill="none" stroke="#78a7ff"/><path d="M31 73 H66" stroke="#78a7ff"/>
        <text x="80" y="65" fill="#a8c8ff" fontSize="13">EDGE</text><text x="81" y="94" textAnchor="middle" fill="#9caeb6" fontSize="11">Laptop / orchestration</text>
        <rect x="466" y="36" width="146" height="80" rx="8" fill="#12241e" stroke={cloudConnected ? '#67f2ba' : '#65796b'} strokeOpacity=".65"/>
        <rect x="486" y="50" width="25" height="22" rx="2" fill="none" stroke="#67f2ba"/><path d="M490 57 H507 M490 64 H507" stroke="#67f2ba"/>
        <text x="525" y="65" fill="#c4fce0" fontSize="13">CLOUD</text><text x="539" y="94" textAnchor="middle" fill="#9bb9a7" fontSize="11">Outshift / server</text>
        <path d="M155 60 C265 22 350 22 465 60" className="packet-track" stroke="#78a7ff"/>
        <path d="M465 92 C350 130 265 130 155 92" className="packet-track" stroke="#67f2ba"/>
        {cloudConnected && <><path d="M155 60 C265 22 350 22 465 60" className="data-packet packet-outbound" stroke="#78a7ff"/><path d="M465 92 C350 130 265 130 155 92" className="data-packet packet-inbound" stroke="#67f2ba"/></>}
        <text x="310" y="21" textAnchor="middle" fill="#a8c8ff" fontSize="10" letterSpacing="1">PROMPT + WEIGHT VECTOR →</text>
        <text x="310" y="144" textAnchor="middle" fill="#a5eac7" fontSize="10" letterSpacing="1">← FUSED OUTPUT + AUDIT</text>
      </svg>
      <div className="flow-caption"><span>{cloudExecution ? 'CLOUD EXECUTION CONFIRMED' : 'ARCHITECTURE SCHEMATIC'} · {cloudConnected ? 'LINK AVAILABLE' : 'LINK UNAVAILABLE'}</span><span>{cloudRttMs !== null && cloudRttMs !== undefined ? `Health RTT ${cloudRttMs.toFixed(1)} ms` : 'Health RTT —'}</span></div>
    </div>
    <svg viewBox={`0 0 620 ${height}`} className="fusion-canvas" aria-hidden="true">
      <defs><radialGradient id="core-aura"><stop stopColor="#67f2ba" stopOpacity=".2"/><stop offset="1" stopColor="#67f2ba" stopOpacity="0"/></radialGradient></defs>
      <circle cx="465" cy={height / 2} r="115" fill="url(#core-aura)" />
      {names.map((name, i) => {
        const weight = weights[name] || 0;
        const y = height / 2 + (i - (names.length - 1) / 2) * 54;
        const path = `M150 ${y} C285 ${y} 300 ${height / 2} 411 ${height / 2}`;
        const color = expertColors[i % expertColors.length];
        return <g key={name} style={{ '--beam-color': color, '--beam-duration': `${3 - weight * 2}s` } as CSSProperties}>
          <rect x="8" y={y - 19} width="140" height="38" rx="5" fill={weight ? '#132921' : '#131b20'} stroke={weight ? color : '#2a343b'} strokeOpacity={weight ? .65 : 1}/>
          <text x="20" y={y + 4} fill={weight ? color : '#798c85'} fontSize="11">{(labels[name] || name).slice(0, 13)}</text>
          <text x="137" y={y + 4} fill={weight ? '#e4f9ec' : '#798c85'} fontSize="11" textAnchor="end">{(weight * 100).toFixed(1)}%</text>
          <path d={path} fill="none" stroke={color} strokeWidth="1" opacity={weight ? .3 : .08}/>
          {weight > 0 && <path className="fusion-beam" d={path} fill="none" stroke={color} strokeWidth={1.5 + weight * 5} opacity={.35 + weight * .65}/>} 
        </g>;
      })}
      <circle className="core-orbit" cx="465" cy={height / 2} r="69" fill="none" stroke="#67f2ba" strokeOpacity=".35" strokeDasharray="3 12" />
      <rect x="413" y={height / 2 - 52} width="104" height="104" rx="14" fill="#12241e" stroke="#67f2ba" strokeOpacity=".7" />
      {Array.from({ length: 36 }, (_, i) => <rect key={i} x={441 + (i % 6) * 8} y={height / 2 - 29 + Math.floor(i / 6) * 8} width="5" height="5" rx="1" fill={cells && cells[i] < 0 ? '#78a7ff' : '#67f2ba'} opacity={cells ? .2 + .8 * Math.abs(cells[i]) / peak : .2 + ((i * 7) % 10) / 12} />)}
      <text x="465" y={height / 2 + 34} fill="#d9ffee" textAnchor="middle" fontSize="11" letterSpacing="2">BASE MODEL</text>
      <path d={`M519 ${height / 2} H577`} stroke="#67f2ba" strokeWidth="2" opacity=".55"/>
      <circle cx="581" cy={height / 2} r="4" fill="#67f2ba" />
      <text x="465" y={height / 2 + 98} textAnchor="middle" fill="#8da99c" fontSize="9" letterSpacing="1">{layers ? `${layers} MATRICES FUSED` : 'W base + Σ αᵢ ΔWᵢ'}</text>
    </svg>
    <div className="core-bottomline flex items-center justify-between gap-3"><span>{names.filter(name => weights[name] > 0).length} ACTIVE SIGNALS</span><span>{cells ? 'REAL MATRIX SAMPLE' : 'SCHEMATIC · AWAITING INFERENCE'}</span></div>
  </div>;
}
