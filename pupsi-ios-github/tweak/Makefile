TARGET := pupsi
TARGET_VERSION := 1.0
PACKAGE_ID := com.static.pupsi.tweak
ARCHS := arm64
THEOS_PACKAGE_SCHEME := rootless

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = Pupsi
Pupsi_FILES = Tweak.xm PupsiSchemeHandler.m
Pupsi_FRAMEWORKS = WebKit Foundation
Pupsi_CFLAGS = -fobjc-arc

include $(THEOS_MAKE_PATH)/tweak.mk

after-install::
	install.exec "killall -9 Chess 2>/dev/null || true"
