export function injectArtifactErrorForwarder(html: string): string {
  const script = `<script>
(function(){
  function excerpt(source, lineNumber, radius){
    if (!source || !lineNumber || lineNumber < 1) return '';
    var lines = String(source).split('\\n');
    var start = Math.max(0, lineNumber - (radius || 5) - 1);
    var end = Math.min(lines.length, lineNumber + (radius || 5));
    return lines.slice(start, end).map(function(line, idx){
      return (start + idx + 1) + ': ' + line;
    }).join('\\n');
  }
  function post(message, details){
    window.parent.postMessage(Object.assign({ type: 'artifact-error', message: message || 'Unknown runtime error' }, details || {}), '*');
  }
  window.addEventListener('error', function(e){
    post(e.message, { diagnosticKind: 'js-error', filename: e.filename, lineno: e.lineno, colno: e.colno, stack: e.error && e.error.stack });
  });
  window.addEventListener('unhandledrejection', function(e){
    post(e.reason && e.reason.message || String(e.reason), { diagnosticKind: 'promise-rejection', stack: e.reason && e.reason.stack });
  });
  if ('GPUDevice' in window && window.GPUDevice && window.GPUDevice.prototype) {
    var shaderModules = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    var lastPipelineInfo = null;
    var recentShaderErrorAt = 0;
    function shaderInfo(module){
      return shaderModules && module ? shaderModules.get(module) : null;
    }
    function stageInfo(stage, stageName, pipelineLabel){
      if (!stage) return null;
      var info = shaderInfo(stage.module) || {};
      var inferredLabel = info.label || ((pipelineLabel ? pipelineLabel + ' ' : '') + stageName + ' shader');
      if (shaderModules && stage.module && info && !info.label) {
        info.label = inferredLabel;
        shaderModules.set(stage.module, info);
      }
      return {
        shaderLabel: inferredLabel,
        shaderSource: info.code,
        entryPoint: stage.entryPoint
      };
    }
    function combineShaderSources(stages){
      return stages.filter(Boolean).map(function(stage){
        return '/* ' + (stage.shaderLabel || 'shader') + (stage.entryPoint ? ' entryPoint=' + stage.entryPoint : '') + ' */\\n' + (stage.shaderSource || '');
      }).join('\\n\\n');
    }
    function pipelineInfo(descriptor, kind){
      if (!descriptor) return { pipelineKind: kind };
      var vertex = stageInfo(descriptor.vertex, 'vertex', descriptor.label);
      var fragment = stageInfo(descriptor.fragment, 'fragment', descriptor.label);
      var compute = stageInfo(descriptor.compute, 'compute', descriptor.label);
      return {
        diagnosticKind: 'webgpu-validation',
        pipelineKind: kind,
        pipelineLabel: descriptor.label,
        shaderLabel: descriptor.label ? descriptor.label + ' pipeline shaders' : kind + ' pipeline shaders',
        shaderSource: combineShaderSources([vertex, fragment, compute]),
        vertex: vertex,
        fragment: fragment,
        compute: compute
      };
    }
    var originalCreateShaderModule = window.GPUDevice.prototype.createShaderModule;
    if (originalCreateShaderModule && !originalCreateShaderModule.__porrimaWrapped) {
      var wrapped = function(descriptor){
        if (this && this.addEventListener && !this.__porrimaErrorForwarded) {
          this.__porrimaErrorForwarded = true;
          this.addEventListener('uncapturederror', function(e){
            var message = e.error && e.error.message || 'WebGPU validation error';
            var details = Object.assign({ diagnosticKind: 'webgpu-validation' }, lastPipelineInfo || {});
            if (/Invalid ShaderModule[\\s\\S]*previous error/i.test(message)) {
              setTimeout(function(){
                if (Date.now() - recentShaderErrorAt < 1000) return;
                post(message, details);
              }, 150);
              return;
            }
            post(message, details);
          });
        }
        var module = originalCreateShaderModule.call(this, descriptor);
        if (shaderModules && module) {
          shaderModules.set(module, {
            label: descriptor && descriptor.label || '',
            code: descriptor && typeof descriptor.code === 'string' ? descriptor.code : ''
          });
        }
        if (module && module.getCompilationInfo) {
          module.getCompilationInfo().then(function(info){
            var errors = (info.messages || []).filter(function(m){ return m.type === 'error'; });
            if (errors.length) {
              recentShaderErrorAt = Date.now();
              var first = errors[0];
              var storedInfo = shaderInfo(module) || {};
              post('WebGPU shader compilation error: ' + first.message, {
                diagnosticKind: 'webgpu-shader',
                shaderLabel: storedInfo.label || descriptor && descriptor.label || 'unlabeled shader module',
                shaderSource: descriptor && typeof descriptor.code === 'string' ? descriptor.code : '',
                shaderLine: first.lineNum,
                shaderColumn: first.linePos,
                shaderExcerpt: excerpt(descriptor && descriptor.code, first.lineNum, 6),
                compilationMessages: (info.messages || []).map(function(m){
                  return {
                    type: m.type,
                    message: m.message,
                    lineNum: m.lineNum,
                    linePos: m.linePos,
                    offset: m.offset,
                    length: m.length
                  };
                }),
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
    var originalCreateRenderPipeline = window.GPUDevice.prototype.createRenderPipeline;
    if (originalCreateRenderPipeline && !originalCreateRenderPipeline.__porrimaWrapped) {
      var wrappedRenderPipeline = function(descriptor){
        lastPipelineInfo = pipelineInfo(descriptor, 'render');
        return originalCreateRenderPipeline.call(this, descriptor);
      };
      wrappedRenderPipeline.__porrimaWrapped = true;
      window.GPUDevice.prototype.createRenderPipeline = wrappedRenderPipeline;
    }
    var originalCreateComputePipeline = window.GPUDevice.prototype.createComputePipeline;
    if (originalCreateComputePipeline && !originalCreateComputePipeline.__porrimaWrapped) {
      var wrappedComputePipeline = function(descriptor){
        lastPipelineInfo = pipelineInfo(descriptor, 'compute');
        return originalCreateComputePipeline.call(this, descriptor);
      };
      wrappedComputePipeline.__porrimaWrapped = true;
      window.GPUDevice.prototype.createComputePipeline = wrappedComputePipeline;
    }
  }
})();
<\/script>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${script}</head>`);
  if (/<body\b/i.test(html)) return html.replace(/<body\b/i, `${script}<body`);
  return `${script}${html}`;
}
