#if defined(__linux__)
#define _GNU_SOURCE
#endif

#include <errno.h>
#include <stdlib.h>

#if defined(__APPLE__)
#include <stdio.h>
#elif defined(__linux__)
#include <fcntl.h>
#include <linux/fs.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif

enum {
  EXIT_USAGE = 64,
  EXIT_DESTINATION_EXISTS = 73,
  EXIT_DIFFERENT_FILESYSTEM = 74,
  EXIT_RENAME_FAILED = 75
};

int main(int argc, char **argv) {
  if (argc != 3 || argv[1][0] != '/' || argv[2][0] != '/') return EXIT_USAGE;

#if defined(__APPLE__)
  if (renamex_np(argv[1], argv[2], RENAME_EXCL) == 0) return EXIT_SUCCESS;
#elif defined(__linux__)
  if (syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_NOREPLACE) == 0) {
    return EXIT_SUCCESS;
  }
#else
  return EXIT_RENAME_FAILED;
#endif

  if (errno == EEXIST || errno == ENOTEMPTY) return EXIT_DESTINATION_EXISTS;
  if (errno == EXDEV) return EXIT_DIFFERENT_FILESYSTEM;
  return EXIT_RENAME_FAILED;
}
