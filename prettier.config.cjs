module.exports = {
    printWidth: 120,
    useTabs: false,
    tabWidth: 2,
    overrides: [
      {
        files: [
          "*.ts", "*.tsx"
        ],
        options: {
          arrowParens: "avoid",
          semi: true,
          singleQuote: true,
          trailingComma: "all",
          tabWidth: 4,
        }
      },
      {
        files: [
          "*.yml", "*.yaml"
        ],
        options: {
          parser: "yaml"
        }
      }
    ]
  };