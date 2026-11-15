module.exports = function (config) {
  config.set({
    frameworks: ['jasmine'],
    customLaunchers: {
      ChromeHeadlessNoGpu: {
        base: 'ChromeHeadless',
        flags: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
      },
    },
  });
};
