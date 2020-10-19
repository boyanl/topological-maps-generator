const path = require('path');

module.exports = {
    mode: "development",
    entry: "./tm-editor.ts",
    devtool: 'inline-source-map',
    devServer: {
        port: 8081,
        watchContentBase: true
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.css$/i,
                use: ['style-loader', 'css-loader'],
            }
        ],
    },
    resolve: {
        extensions: [ '.ts', '.js' ]
    },
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, 'dist'),
        publicPath: "/dist/",
    },
}
