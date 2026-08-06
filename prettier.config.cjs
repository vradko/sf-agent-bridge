module.exports = {
    plugins: ['@prettier/plugin-xml', 'prettier-plugin-apex'],
    printWidth: 120,
    singleQuote: true,
    trailingComma: 'none',
    overrides: [
        {
            files: '**/lwc/**/*.html',
            options: { parser: 'lwc' }
        },
        {
            files: '*.xml',
            options: { parser: 'xml' }
        },
        {
            files: '*.{cls,trigger}',
            options: { parser: 'apex' }
        }
    ]
};
