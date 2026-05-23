export function injectArtifactErrorForwarder(html: string): string {
  const script = `<script>
(function(){
  function post(message, details){
    window.parent.postMessage(Object.assign({ type: 'artifact-error', message: message || 'Unknown runtime error' }, details || {}), '*');
  }
  window.addEventListener('error', function(e){
    post(e.message, { filename: e.filename, lineno: e.lineno, colno: e.colno, stack: e.error && e.error.stack });
  });
  window.addEventListener('unhandledrejection', function(e){
    post(e.reason && e.reason.message || String(e.reason), { stack: e.reason && e.reason.stack });
  });
  if ('GPUDevice' in window && window.GPUDevice && window.GPUDevice.prototype) {
    var originalCreateShaderModule = window.GPUDevice.prototype.createShaderModule;
    if (originalCreateShaderModule && !originalCreateShaderModule.__porrimaWrapped) {
      var wrapped = function(descriptor){
        if (this && this.addEventListener && !this.__porrimaErrorForwarded) {
          this.__porrimaErrorForwarded = true;
          this.addEventListener('uncapturederror', function(e){
            post(e.error && e.error.message || 'WebGPU validation error');
          });
        }
        var module = originalCreateShaderModule.call(this, descriptor);
        if (module && module.getCompilationInfo) {
          module.getCompilationInfo().then(function(info){
            var errors = (info.messages || []).filter(function(m){ return m.type === 'error'; });
            if (errors.length) {
              var first = errors[0];
              post('WebGPU shader compilation error: ' + first.message, {
                lineno: first.lineNum,
                colno: first.linePos,
                stack: errors.map(function(m){
                  return (m.lineNum ? (m.lineNum + ':' + m.linePos + ' ') : '') + m.message;
                }).join('\\n')
              });
            }
          }).catch(function(err){
            post(err && err.message || String(err));
          });
        }
        return module;
      };
      wrapped.__porrimaWrapped = true;
      window.GPUDevice.prototype.createShaderModule = wrapped;
    }
  }
})();
<\/script>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${script}</head>`);
  if (/<body\b/i.test(html)) return html.replace(/<body\b/i, `${script}<body`);
  return `${script}${html}`;
}
