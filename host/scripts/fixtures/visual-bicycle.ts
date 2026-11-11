export const obstruction = 'id="foreground" fill="#ee2222"'
export const correction = 'id="foreground" fill="#ee2222" visibility="hidden"'

export function visualBicycle(animal: '鹈鹕' | '鳄鱼') {
  const body = animal === '鹈鹕' ? '<path d="M190 150Q170 109 245 98Q283 72 279 48Q281 27 307 35L356 47L305 63Q300 143 255 161Z" fill="#f2efe0"/>'
    : '<path d="M175 151L130 126Q165 136 193 115Q220 88 287 94L335 80L367 105L323 122Q283 154 245 162Z" fill="#4d9254"/>'
  return `<!doctype html><meta charset="utf-8"><title>${animal}骑自行车</title><style>body{margin:0;background:#e7f4f4}</style>
<svg width="640" height="360" viewBox="0 0 640 360"><path d="M0 280H640" stroke="#a3c8bd" stroke-width="4"/>
<circle cx="226" cy="236" r="44" fill="none" stroke="#172a35" stroke-width="8"/>
<circle cx="426" cy="236" r="44" fill="none" stroke="#172a35" stroke-width="8"/>
<path d="M226 236l52-85 40 85-92 0m92 0l68-91-108 6m108-6 40 91m-40-91-10-25h22" fill="none" stroke="#23707c" stroke-width="7"/>
${body}<polyline id="leg" points="252,144 276,193 318,236" fill="none" stroke="#dfab50" stroke-width="8"/>
<circle id="pedal" cx="318" cy="236" r="6" fill="#1c3841"/><circle id="marker" cx="100" cy="70" r="15" fill="#ffbb00"/>
<rect ${obstruction} x="390" y="190" width="115" height="95"/></svg>
<script>const pedal=document.getElementById('pedal'),leg=document.getElementById('leg'),marker=document.getElementById('marker');
let start;function spin(now){start??=now;const ms=now-start,a=ms*Math.PI/450,x=318+17*Math.cos(a),y=236+17*Math.sin(a);
pedal.setAttribute('cx',x);pedal.setAttribute('cy',y);leg.setAttribute('points','252,144 '+(277+10*Math.cos(a))+',194 '+x+','+y);
marker.setAttribute('fill',ms>400?'#008888':'#ffbb00');requestAnimationFrame(spin);}requestAnimationFrame(spin);</script>`
}
