(function(){"use strict";let t;addEventListener("message",s=>{const e=s.data;typeof e!="number"||!(e>0)||(clearInterval(t),t=setInterval(()=>postMessage("beat"),e))})})();
