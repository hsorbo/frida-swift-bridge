struct CFixturePoint {
    int x;
    int y;
};
typedef struct CFixturePoint CFixturePoint;

typedef enum __attribute__((enum_extensibility(open))) CFixtureMode {
    CFixtureModeOff = 0,
    CFixtureModeOn = 1,
} CFixtureMode;

typedef enum __attribute__((flag_enum, enum_extensibility(open))) CFixtureFlags {
    CFixtureFlagsBold = 1 << 0,
    CFixtureFlagsItalic = 1 << 1,
} CFixtureFlags;
