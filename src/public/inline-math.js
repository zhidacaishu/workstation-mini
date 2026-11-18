// KaTeX 的斜体和零宽公式可以伸出自己的排版框。只有整个公式宽于可用栏宽时才裁剪并滚动。
(() => {
  const observer = new ResizeObserver(entries => {
    for (const { target } of entries) {
      const wrapper = target.closest('inline-math');
      const content = wrapper?.firstElementChild;
      if (content) wrapper.classList.toggle('is-wide',
        content.getBoundingClientRect().width > wrapper.getBoundingClientRect().width + 0.5);
    }
  });

  customElements.define('inline-math', class extends HTMLElement {
    connectedCallback() {
      observer.observe(this);
      if (this.firstElementChild) observer.observe(this.firstElementChild);
    }
    disconnectedCallback() {
      observer.unobserve(this);
      if (this.firstElementChild) observer.unobserve(this.firstElementChild);
    }
  });
})();
