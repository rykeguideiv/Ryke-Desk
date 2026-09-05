{
  "targets": [
    {
      "target_name": "ryke_captura",
      "sources": [
        "src/addon.cc",
        "src/duplicador.cc"
      ],
      "include_dirs": [
        "node_modules/node-addon-api"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "NOMINMAX",
        "WIN32_LEAN_AND_MEAN"
      ],
      "conditions": [
        [
          "OS==\"win\"",
          {
            "libraries": [
              "-ld3d11.lib",
              "-ldxgi.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": [ "/std:c++17" ]
              }
            }
          }
        ]
      ]
    }
  ]
}
