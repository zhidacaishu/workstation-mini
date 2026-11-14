// 页面切换的淡入淡出（styles.css 里的 @view-transition）被打断时——连续点了两次、窗口在后台、
// 新页面还没排好——浏览器会让过渡的 Promise 失败，控制台报一条「Transition was skipped」。
// 这不是错误，接住它。pagereveal 在第一帧之前触发，所以这个文件不能 defer，要放在 <head> 里直接执行。
(() => {
  for (const type of ['pageswap', 'pagereveal']) {
    window.addEventListener(type, event => {
      const transition = event.viewTransition;
      if (!transition) return;
      for (const name of ['ready', 'finished', 'updateCallbackDone']) transition[name]?.catch?.(() => {});
    });
  }
})();
