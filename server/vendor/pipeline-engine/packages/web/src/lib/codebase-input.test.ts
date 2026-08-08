import { describe, expect, test } from 'bun:test';
import { getCodebaseInput } from '@/lib/codebase-input';

describe('getCodebaseInput', () => {
  test('treats GitHub repository inputs as urls', () => {
    expect(getCodebaseInput('https://github.com/example-org/research-app')).toEqual({
      url: 'https://github.com/example-org/research-app',
    });
  });

  test('treats SSH git@ shorthand as urls', () => {
    expect(getCodebaseInput('git@github.com:example-org/research-app.git')).toEqual({
      url: 'git@github.com:example-org/research-app.git',
    });
  });

  test('treats ssh:// URLs as urls', () => {
    expect(getCodebaseInput('ssh://git@github.com/example-org/research-app.git')).toEqual({
      url: 'ssh://git@github.com/example-org/research-app.git',
    });
  });

  test('treats git:// URLs as urls', () => {
    expect(getCodebaseInput('git://github.com/example-org/research-app.git')).toEqual({
      url: 'git://github.com/example-org/research-app.git',
    });
  });

  test('trims surrounding whitespace before classifying', () => {
    expect(getCodebaseInput('  https://github.com/a/b  ')).toEqual({
      url: 'https://github.com/a/b',
    });
  });

  test('treats relative local paths as paths', () => {
    expect(getCodebaseInput('./repo')).toEqual({ path: './repo' });
    expect(getCodebaseInput('../repo')).toEqual({ path: '../repo' });
    expect(getCodebaseInput('repo')).toEqual({ path: 'repo' });
  });

  test('treats unix local paths as paths', () => {
    expect(getCodebaseInput('/path/to/repository')).toEqual({
      path: '/path/to/repository',
    });
  });

  test('treats home-relative paths as paths', () => {
    expect(getCodebaseInput('~/src/pipeline')).toEqual({
      path: '~/src/pipeline',
    });
  });

  test('treats windows local paths as paths', () => {
    expect(getCodebaseInput('C:\\repo\\pipeline')).toEqual({
      path: 'C:\\repo\\pipeline',
    });
  });

  test('treats windows UNC paths as paths', () => {
    expect(getCodebaseInput('\\\\server\\share\\pipeline')).toEqual({
      path: '\\\\server\\share\\pipeline',
    });
  });
});
