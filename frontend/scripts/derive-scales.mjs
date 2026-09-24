// Derive 50-950 Tailwind scales from a single anchor by mixing in OKLab
// toward a warm white (paper) and warm black (night), so every scale shares
// the same cast. Prints a JS object for tailwind.config.js plus contrast checks.
const hex2rgb = h => [1,3,5].map(i => parseInt(h.slice(i,i+2),16)/255);
const rgb2hex = c => '#' + c.map(v => Math.round(Math.min(1,Math.max(0,v))*255).toString(16).padStart(2,'0')).join('').toUpperCase();
const lin = v => v <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4;
const gam = v => v <= 0.0031308 ? 12.92*v : 1.055*v**(1/2.4)-0.055;
function rgb2oklab([r,g,b]) {
  r=lin(r); g=lin(g); b=lin(b);
  const l = Math.cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b);
  const m = Math.cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b);
  const s = Math.cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b);
  return [0.2104542553*l+0.7936177850*m-0.0040720468*s, 1.9779984951*l-2.4285922050*m+0.4505937099*s, 0.0259040371*l+0.7827717662*m-0.8086757660*s];
}
function oklab2rgb([L,a,b]) {
  const l=(L+0.3963377774*a+0.2158037573*b)**3, m=(L-0.1055613458*a-0.0638541728*b)**3, s=(L-0.0894841775*a-1.2914855480*b)**3;
  return [gam(4.0767416621*l-3.3077115913*m+0.2309699292*s), gam(-1.2684380046*l+2.6097574011*m-0.3413193965*s), gam(-0.0041960863*l-0.7034186147*m+1.7076147010*s)];
}
const mix = (a,b,t) => { const A=rgb2oklab(hex2rgb(a)), B=rgb2oklab(hex2rgb(b)); return rgb2hex(oklab2rgb(A.map((v,i)=>v+(B[i]-v)*t))); };
const lum = h => { const [r,g,b]=hex2rgb(h).map(lin); return 0.2126*r+0.7152*g+0.0722*b; };
export const contrast = (a,b) => { const l1=lum(a), l2=lum(b); return ((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)); };

const PAPER='#F7F4F1', NIGHT='#14100F', WHITE='#FFFFFF';
const STEPS=[50,100,200,300,400,500,600,700,800,900,950];
// t-curve: how far from the anchor toward white (for lighter) / night (for darker)
function scale(anchor, anchorStep, light={}, dark={}) {
  const out={};
  const lightT = {50:0.94,100:0.86,200:0.70,300:0.50,400:0.28,500:0.14}; // used for steps lighter than anchor
  const darkT  = {500:0.14,600:0.28,700:0.42,800:0.56,900:0.70,950:0.82};
  const ai = STEPS.indexOf(anchorStep);
  STEPS.forEach((s,i)=>{
    if (i===ai) out[s]=anchor.toUpperCase();
    else if (i<ai) { // lighter: interpolate fraction across the lighter steps
      const frac = (ai-i)/ai; // 1 at 50
      out[s]=mix(anchor, s<=100?WHITE:PAPER, light[s] ?? (0.06+0.90*frac**0.85));
    } else {
      const frac = (i-ai)/(STEPS.length-1-ai); // 1 at 950
      out[s]=mix(anchor, NIGHT, dark[s] ?? (0.08+0.78*frac**0.9));
    }
  });
  return out;
}
const scales = {
  // warm neutral: hand-pinned to the named tokens, generated in between
  gray: {50:'#F7F4F1',100:'#F1ECE8',200:'#E2DBD5',300:'#C9C2BC',400:mix('#C9C2BC','#6A615D',0.45),500:'#6A615D',600:mix('#6A615D','#3A332E',0.5),700:'#3A332E',800:'#2E2825',900:'#14100F',950:'#0C0908'},
  brand:   scale('#6B2E8A',600),
  ok:      scale('#5FB07E',400),
  caution: scale('#C9903A',400),
  alarm:   scale('#A3132E',600),
  lighting:scale('#A46BC6',400),
  water:   scale('#4E93B8',400),
};
console.log(JSON.stringify(scales,null,2));
const c=(a,b)=>contrast(a,b).toFixed(2);
const g=scales.gray;
console.log('\n# contrast checks');
console.log('gray-500 on white', c(g[500],'#FFFFFF'));
console.log('gray-500 on paper', c(g[500],'#F7F4F1'));
console.log('gray-400 on white', c(g[400],'#FFFFFF'));
console.log('gray-400 on char(dark panel)', c(g[400],'#2E2825'));
console.log('gray-500 on char', c(g[500],'#2E2825'));
console.log('gray-300 on char', c(g[300],'#2E2825'));
console.log('gray-600 on white', c(g[600],'#FFFFFF'));
console.log('night on paper', c('#14100F','#F7F4F1'));
console.log('paper on night', c('#F7F4F1','#14100F'));
console.log('stone on white', c('#6A615D','#FFFFFF'));
console.log('ash on char', c('#C9C2BC','#2E2825'));
for (const [n,s] of Object.entries(scales)) if(n!=='gray'){
  console.log(n, '600/white', c(s[600],'#FFFFFF'), '700/white', c(s[700],'#FFFFFF'), '500/white', c(s[500],'#FFFFFF'), '400/char', c(s[400],'#2E2825'), '300/char', c(s[300],'#2E2825'), '800 on 100', c(s[800],s[100]), '600 on 50', c(s[600],s[50]), '200 on 900', c(s[200],s[900]));
}
